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
