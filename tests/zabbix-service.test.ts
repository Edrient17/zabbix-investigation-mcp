import { describe, expect, it } from "vitest";
import type { QueryPolicy, ZabbixApi } from "../src/types.js";
import { ZabbixService } from "../src/zabbix-service.js";

class MockZabbixApi implements ZabbixApi {
  readonly calls: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly handlers: Record<
      string,
      (params: Record<string, unknown>) => unknown
    >,
  ) {}

  async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) {
      throw new Error(`Unexpected Zabbix method: ${method}`);
    }
    return handler(params) as T;
  }
}

function makePolicy(
  overrides: Partial<QueryPolicy> = {},
): QueryPolicy {
  return {
    maxWindowHours: 26,
    longTermMaxDays: 30,
    maxEvents: 100,
    maxItemsPerCall: 20,
    maxHistoryPoints: 1_000,
    maxSourcePoints: 50_000,
    maxFutureHours: 2,
    minCoverageRatio: 0.95,
    allowedHostGroupIds: ["10"],
    maxRawRows: 50,
    maxRawResultChars: 12_000,
    rawQueryMethods: [],
    ...overrides,
  };
}

const allowedHost = {
  hostid: "10084",
  host: "Java-test",
  name: "Java Test Server",
  status: "0",
  hostgroups: [{ groupid: "10", name: "Application Servers" }],
};

const cpuItem = {
  itemid: "42269",
  hostid: "10084",
  name: "CPU utilization",
  key_: "system.cpu.util",
  value_type: "0",
  units: "%",
  status: "0",
  state: "0",
  delay: "1m",
  history: "7d",
  trends: "365d",
};

describe("ZabbixService", () => {
  it("applies the configured host group allowlist to host searches", async () => {
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.findHosts({ query: "Java" });

    expect(result.hosts).toEqual([
      {
        host_id: "10084",
        host: "Java-test",
        name: "Java Test Server",
        status: "monitored",
        groups: [{ group_id: "10", name: "Application Servers" }],
      },
    ]);
    expect(api.calls[0]?.params.groupids).toEqual(["10"]);
  });

  it("lists a host group so an estate-wide request can find its subjects", async () => {
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost, { ...allowedHost, hostid: "10085", host: "Java-2" }],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.findHosts({ group_ids: ["10"] });

    expect(api.calls[0]?.params).toMatchObject({ groupids: ["10"] });
    // No name to search on: the group is the whole selection.
    expect(api.calls[0]?.params.search).toBeUndefined();
    expect(result).toMatchObject({
      query: null,
      group_ids: ["10"],
      result_count: 2,
      truncated: false,
    });
  });

  // The allowlist is the boundary the server rests on, so a caller cannot widen
  // its own reach by naming a group outside it.
  it("narrows requested groups to the allowlist and says which it dropped", async () => {
    const api = new MockZabbixApi({ "host.get": () => [allowedHost] });
    const service = new ZabbixService(api, makePolicy({ allowedHostGroupIds: ["10", "11"] }));

    const result = await service.findHosts({ group_ids: ["10", "99"] });

    expect(api.calls[0]?.params).toMatchObject({ groupids: ["10"] });
    expect(result).toMatchObject({ group_ids: ["10"], excluded_group_ids: ["99"] });
  });

  it("refuses a request for groups that are all outside the allowlist", async () => {
    const api = new MockZabbixApi({ "host.get": () => [] });
    const service = new ZabbixService(api, makePolicy({ allowedHostGroupIds: ["10"] }));

    // Not an empty result: that would read as "the group has no hosts", which
    // is a different fact from "you may not look there".
    await expect(service.findHosts({ group_ids: ["99"] })).rejects.toMatchObject({
      code: "HOST_GROUP_NOT_ALLOWED",
      status: 403,
    });
    expect(api.calls).toHaveLength(0);
  });

  it("still searches by name, and reports when the result was cut short", async () => {
    const api = new MockZabbixApi({
      "host.get": () => Array.from({ length: 10 }, (_, index) => ({
        ...allowedHost,
        hostid: String(20000 + index),
      })),
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.findHosts({ query: "Java" });

    expect(api.calls[0]?.params).toMatchObject({
      search: { host: "Java", name: "Java" },
      searchByAny: true,
      limit: 10,
    });
    expect(result).toMatchObject({ query: "Java", truncated: true });
  });

  it("requires something to select on", async () => {
    const api = new MockZabbixApi({ "host.get": () => [] });
    const service = new ZabbixService(api, makePolicy());

    await expect(service.findHosts({})).rejects.toMatchObject({
      code: "QUERY_OR_GROUP_REQUIRED",
    });
    expect(api.calls).toHaveLength(0);
  });

  it("aggregates history in the MCP instead of delegating arithmetic to the Agent", async () => {
    const from = Date.parse("2026-07-30T01:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "history.get": () =>
        Array.from({ length: 10 }, (_, index) => ({
          itemid: "42269",
          clock: String(from + index * 60),
          ns: "0",
          value: String(index + 1),
        })),
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getMetricSummary({
      host_id: "10084",
      item_ids: ["42269"],
      time_from: "2026-07-30T01:00:00Z",
      time_to: "2026-07-30T01:10:00Z",
      aggregation: "5m",
      include_points: true,
    });
    const series = result.series as Array<Record<string, unknown>>;
    const first = series[0];

    expect(first?.summary).toMatchObject({
      min: 1,
      max: 10,
      avg: 5.5,
      trend: "increasing",
    });
    expect(first?.data_quality).toMatchObject({
      data_source: "history",
      sample_count: 10,
      returned_points: 2,
      coverage_ratio: 1,
      partial: false,
    });
  });

  // Every bucket returned here stays in the caller's conversation and is
  // re-sent on each turn of the investigation, so the survey step returns
  // statistics only unless the caller asks for the shape.
  it("omits the per-bucket points unless they are asked for", async () => {
    const from = Date.parse("2026-07-30T01:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "history.get": () =>
        Array.from({ length: 10 }, (_, index) => ({
          itemid: "42269",
          clock: String(from + index * 60),
          ns: "0",
          value: String(index + 1),
        })),
    });
    const service = new ZabbixService(api, makePolicy());
    const ask = async (include_points?: boolean) => {
      const result = await service.getMetricSummary({
        host_id: "10084",
        item_ids: ["42269"],
        time_from: "2026-07-30T01:00:00Z",
        time_to: "2026-07-30T01:10:00Z",
        aggregation: "5m",
        ...(include_points === undefined ? {} : { include_points }),
      });
      return (result.series as Array<Record<string, unknown>>)[0]!;
    };

    for (const omitted of [await ask(), await ask(false)]) {
      expect(omitted.points).toEqual([]);
      expect(omitted.data_quality).toMatchObject({ returned_points: 0 });
      // The statistics survive: they are what the survey step reads.
      expect(omitted.summary).toMatchObject({ min: 1, max: 10, avg: 5.5 });
      // Nothing was truncated, so coverage must not be reported as partial.
      expect(omitted.data_quality).toMatchObject({ partial: false });
    }

    const asked = await ask(true);
    expect((asked.points as unknown[]).length).toBe(2);
  });

  it("uses trend data for a long-term capacity query", async () => {
    const from = Date.parse("2026-07-01T00:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "trend.get": () => [
        {
          itemid: "42269",
          clock: String(from),
          num: "60",
          value_min: "10",
          value_avg: "20",
          value_max: "30",
        },
        {
          itemid: "42269",
          clock: String(from + 3600),
          num: "60",
          value_min: "20",
          value_avg: "30",
          value_max: "40",
        },
      ],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getMetricSummary({
      host_id: "10084",
      item_ids: ["42269"],
      time_from: "2026-07-01T00:00:00Z",
      time_to: "2026-07-02T00:00:00Z",
      aggregation: "1h",
      policy: "long_term_capacity",
      include_points: true,
    });
    const series = result.series as Array<Record<string, unknown>>;

    expect(series[0]?.data_quality).toMatchObject({
      data_source: "trends",
      sample_count: 120,
      returned_points: 2,
      coverage_ratio: 0.083333,
    });
    expect(api.calls.some((call) => call.method === "history.get")).toBe(false);
  });

  it("marks a sparsely covered window partial even when nothing was truncated", async () => {
    // Two hourly trend rows inside a 24h window: nothing hit a query limit, but
    // 22 of 24 buckets have no source data at all.
    const from = Date.parse("2026-07-01T00:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "trend.get": () =>
        Array.from({ length: 2 }, (_, index) => ({
          itemid: "42269",
          clock: String(from + index * 3_600),
          num: "60",
          value_min: "10",
          value_avg: "20",
          value_max: "30",
        })),
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getMetricSummary({
      host_id: "10084",
      item_ids: ["42269"],
      time_from: "2026-07-01T00:00:00Z",
      time_to: "2026-07-02T00:00:00Z",
      aggregation: "1h",
      policy: "long_term_capacity",
      include_points: true,
    });
    const series = result.series as Array<Record<string, unknown>>;

    expect(series[0]?.data_quality).toMatchObject({
      returned_points: 2,
      expected_buckets: 24,
      coverage_ratio: 0.083333,
      partial: true,
    });
  });

  it("keeps a fully covered window non-partial", async () => {
    const from = Date.parse("2026-07-30T01:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "history.get": () =>
        Array.from({ length: 10 }, (_, index) => ({
          itemid: "42269",
          clock: String(from + index * 60),
          ns: "0",
          value: String(index + 1),
        })),
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getMetricHistory({
      host_id: "10084",
      item_id: "42269",
      time_from: "2026-07-30T01:00:00Z",
      time_to: "2026-07-30T01:10:00Z",
      aggregation: "5m",
    });

    expect(result.data_quality).toMatchObject({
      coverage_ratio: 1,
      partial: false,
    });
  });

  it("honours a relaxed minimum coverage ratio", async () => {
    const from = Date.parse("2026-07-01T00:00:00Z") / 1_000;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "item.get": () => [cpuItem],
      "trend.get": () =>
        Array.from({ length: 2 }, (_, index) => ({
          itemid: "42269",
          clock: String(from + index * 3_600),
          num: "60",
          value_min: "10",
          value_avg: "20",
          value_max: "30",
        })),
    });
    const service = new ZabbixService(
      api,
      makePolicy({ minCoverageRatio: 0 }),
    );

    const result = await service.getMetricSummary({
      host_id: "10084",
      item_ids: ["42269"],
      time_from: "2026-07-01T00:00:00Z",
      time_to: "2026-07-02T00:00:00Z",
      aggregation: "1h",
      policy: "long_term_capacity",
    });
    const series = result.series as Array<Record<string, unknown>>;

    expect(series[0]?.data_quality).toMatchObject({
      coverage_ratio: 0.083333,
      partial: false,
    });
  });

  it("rejects hosts outside the group allowlist", async () => {
    const api = new MockZabbixApi({
      "host.get": () => [
        {
          ...allowedHost,
          hostgroups: [{ groupid: "99", name: "Restricted" }],
        },
      ],
    });
    const service = new ZabbixService(api, makePolicy());

    await expect(
      service.listRelevantMetrics({
        host_id: "10084",
        keywords: ["cpu"],
      }),
    ).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
      status: 403,
    });
  });

  it("links a problem event to its recovery event", async () => {
    let eventCall = 0;
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "event.get": (params) => {
        eventCall += 1;
        if ("eventids" in params) {
          return [
            {
              eventid: "20618",
              objectid: "14282",
              clock: "1785375281",
              name: "Java process is running",
              severity: "0",
              value: "0",
            },
          ];
        }
        return [
          {
            eventid: "20617",
            objectid: "14282",
            clock: "1785375012",
            name: "Java process is not running",
            severity: "4",
            value: "1",
            acknowledged: "1",
            r_eventid: "20618",
            suppressed: "0",
            acknowledges: [],
            tags: [],
          },
        ];
      },
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getIncidentEvents({
      host_id: "10084",
      time_from: "2026-07-29T00:00:00Z",
      time_to: "2026-07-29T23:00:00Z",
    });
    const events = result.events as Array<Record<string, unknown>>;

    expect(events[0]).toMatchObject({
      evidence_id: "zbx:event:20617",
      trigger_id: "14282",
      severity: "high",
      recovery_event_id: "20618",
    });
    expect(eventCall).toBe(2);
  });
});

describe("asking about a month of events", () => {
  // The 26-hour cap protects time-series volume. Applied to event queries it
  // was answering "was there anything wrong last month" with one day of last
  // month, and the reply said nothing about the missing 29.
  const monthly = {
    host_id: "10084",
    time_from: "2026-06-30T00:00:00Z",
    time_to: "2026-07-30T00:00:00Z",
  } as const;

  function serviceReturning(events: unknown[]): ZabbixService {
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "event.get": (params) => ("eventids" in params ? [] : events),
    });
    return new ZabbixService(api, makePolicy());
  }

  function problem(id: number): Record<string, unknown> {
    return {
      eventid: String(id),
      objectid: "14282",
      clock: String(1_782_000_000 + id),
      name: "Java process is not running",
      severity: "4",
      value: "1",
      acknowledged: "0",
      suppressed: "0",
      acknowledges: [],
      tags: [],
    };
  }

  it("refuses the month under the default policy", async () => {
    await expect(
      serviceReturning([]).getIncidentEvents({ ...monthly }),
    ).rejects.toThrowError(/exceeds/);
  });

  it("answers the month under long_term_capacity", async () => {
    const result = await serviceReturning([problem(1)]).getIncidentEvents({
      ...monthly,
      policy: "long_term_capacity",
    });
    expect(result.result_count).toBe(1);
    expect(result.partial).toBe(false);
  });

  it("answers a month of related events under long_term_capacity", async () => {
    const result = await serviceReturning([problem(1)]).getRelatedEvents({
      ...monthly,
      trigger_ids: ["14282"],
      policy: "long_term_capacity",
    });
    expect(result.result_count).toBe(1);
  });

  it("marks the answer partial when the row limit is what stopped it", async () => {
    // A month can hold more events than the limit returns. Without this flag
    // the count reads as the real total, and a report writes "3 events last
    // month" from a query that stopped at 3.
    const service = serviceReturning([problem(1), problem(2), problem(3)]);
    const result = await service.getIncidentEvents({
      ...monthly,
      policy: "long_term_capacity",
      limit: 3,
    });
    expect(result.result_count).toBe(3);
    expect(result.partial).toBe(true);
  });
});

describe("saying a moment twice", () => {
  // 02:22:40Z reads like twenty past two. An investigation took the UTC digits
  // of an 11:22 incident, asked the log server for 02:22 local, and searched
  // nine hours from where the incident was -- twice, because the reply it got
  // back agreed with the misreading. The wall clock beside the instant leaves
  // nothing to infer.
  it("reports an event's wall clock beside its UTC instant", async () => {
    // A fixed moment in the past, so the window policy has nothing to say.
    const instant = "2026-08-10T02:22:40.000Z";
    const clock = String(Date.parse(instant) / 1000);

    const api: ZabbixApi = {
      request: async <T>(method: string) => {
        if (method === "host.get") {
          return [{
            hostid: "11082", host: "vm-1", name: "vm-1", status: "0",
            hostgroups: [{ groupid: "73", name: "g" }],
          }] as T;
        }
        if (method === "event.get") {
          return [{
            eventid: "1", objectid: "9", clock, name: "Container stopped",
            severity: "3", value: "1", acknowledged: "0", suppressed: "0",
            tags: [], r_eventid: null,
          }] as T;
        }
        return [] as T;
      },
    };

    const service = new ZabbixService(api, makePolicy({ allowedHostGroupIds: [] }), "Asia/Seoul");
    const result = (await service.getIncidentEvents({
      host_id: "11082",
      time_from: "2026-08-10T00:00:00Z",
      time_to: "2026-08-10T12:00:00Z",
      include_recovery: false,
    })) as { events: Array<{ started_at: string; started_at_local: string }> };

    const event = result.events[0]!;
    expect(event.started_at).toBe(instant);
    // The same moment, nine hours later on the clock -- which is the whole
    // point of printing both.
    expect(event.started_at_local).toBe("2026-08-10 11:22:40 (Asia/Seoul)");
  });
});

/**
 * Naming the host by name rather than by Zabbix id.
 *
 * Five tools took a host_id and nothing else, so a caller that had found the
 * machine in a log index or an agent list -- where no Zabbix id exists -- could
 * not reach them at all, and its investigation silently lost the triggers,
 * events and metrics they would have returned. The id is Zabbix's handle for a
 * machine; the name is what everything else calls it.
 */
describe("addressing a host by name", () => {
  it("resolves the name and queries by the id it found", async () => {
    // event.get rejects a host name outright, so the id has to be produced
    // rather than passed along. Which methods those are is this server's
    // problem, not the caller's.
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "event.get": () => [],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getIncidentEvents({
      host: "Java-test",
      time_from: "2026-07-30T01:00:00Z",
      time_to: "2026-07-30T02:00:00Z",
    });

    const lookup = api.calls.find((call) => call.method === "host.get");
    expect(lookup?.params).toMatchObject({ searchByAny: true });
    expect(lookup?.params.hostids).toBeUndefined();
    const events = api.calls.find((call) => call.method === "event.get");
    expect(events?.params).toMatchObject({ hostids: ["10084"] });
    expect(result).toMatchObject({ host_id: "10084", host: "Java-test" });
  });

  it("matches the visible name too", async () => {
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "event.get": () => [],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getIncidentEvents({
      host: "Java Test Server",
      time_from: "2026-07-30T01:00:00Z",
      time_to: "2026-07-30T02:00:00Z",
    });
    expect(result).toMatchObject({ host_id: "10084" });
  });

  it("does not accept a substring as the host", async () => {
    // Zabbix search is a substring match, so asking about `Java` would
    // otherwise silently answer about `Java-test`.
    const api = new MockZabbixApi({ "host.get": () => [allowedHost] });
    const service = new ZabbixService(api, makePolicy());

    await expect(
      service.listRelevantMetrics({ host: "Java", keywords: ["cpu"] }),
    ).rejects.toMatchObject({ code: "HOST_NOT_FOUND" });
  });

  it("refuses to choose when a name matches several hosts", async () => {
    const twin = {
      ...allowedHost,
      hostid: "10085",
      host: "other",
      name: "Java-test",
    };
    const api = new MockZabbixApi({ "host.get": () => [allowedHost, twin] });
    const service = new ZabbixService(api, makePolicy());

    await expect(
      service.listRelevantMetrics({ host: "Java-test", keywords: ["cpu"] }),
    ).rejects.toMatchObject({ code: "HOST_NAME_AMBIGUOUS" });
  });

  it("holds the allowlist against a name as firmly as against an id", async () => {
    const outside = {
      ...allowedHost,
      hostgroups: [{ groupid: "99", name: "Somewhere else" }],
    };
    const api = new MockZabbixApi({ "host.get": () => [outside] });
    const service = new ZabbixService(api, makePolicy());

    await expect(
      service.listRelevantMetrics({ host: "Java-test", keywords: ["cpu"] }),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED", status: 403 });
  });

  it("says so when neither an id nor a name was given", async () => {
    const api = new MockZabbixApi({ "host.get": () => [allowedHost] });
    const service = new ZabbixService(api, makePolicy());

    await expect(
      service.listRelevantMetrics({ keywords: ["cpu"] }),
    ).rejects.toMatchObject({ code: "HOST_REQUIRED" });
  });

  it("still takes an id, so callers that have one are unaffected", async () => {
    const api = new MockZabbixApi({
      "host.get": () => [allowedHost],
      "event.get": () => [],
    });
    const service = new ZabbixService(api, makePolicy());

    const result = await service.getIncidentEvents({
      host_id: "10084",
      time_from: "2026-07-30T01:00:00Z",
      time_to: "2026-07-30T02:00:00Z",
    });
    const lookup = api.calls.find((call) => call.method === "host.get");
    expect(lookup?.params).toMatchObject({ hostids: ["10084"] });
    expect(result).toMatchObject({ host_id: "10084" });
  });
});
