/**
 * Integration tests against a real Zabbix server.
 *
 * These are skipped unless the environment points at a reachable Zabbix API, so
 * `npm test` and CI stay green on machines that have no Zabbix. To run them:
 *
 *   ssh -L 8081:<zabbix-host>:80 <jump-host>          # if Zabbix is private
 *   ZABBIX_INTEGRATION_URL=http://127.0.0.1:8081/zabbix/api_jsonrpc.php \
 *   ZABBIX_INTEGRATION_HOST=my-host \
 *   npm run test:integration
 *
 * The API token is read from ZABBIX_API_TOKEN, falling back to the repo .env so
 * the secret never has to be passed on the command line.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Logger } from "../../src/logger.js";
import type { QueryPolicy } from "../../src/types.js";
import { ZabbixClient } from "../../src/zabbix-client.js";
import { ZabbixService } from "../../src/zabbix-service.js";

/** Fills in missing process.env keys from .env without clobbering real ones. */
function loadDotEnvFallback(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFallback();

const apiUrl = process.env.ZABBIX_INTEGRATION_URL?.trim();
const apiToken = process.env.ZABBIX_API_TOKEN?.trim();
const hostQuery = process.env.ZABBIX_INTEGRATION_HOST?.trim();
const enabled = Boolean(apiUrl && apiToken && hostQuery);

const policy: QueryPolicy = {
  maxWindowHours: 26,
  longTermMaxDays: 30,
  maxEvents: 100,
  maxItemsPerCall: 20,
  maxHistoryPoints: 1_000,
  maxSourcePoints: 50_000,
  maxFutureHours: 2,
  minCoverageRatio: 0.95,
  allowedHostGroupIds: [],
    maxRawRows: 50,
    maxRawResultChars: 12_000,
    rawQueryMethods: [],
};

const HOUR_MS = 3_600_000;
const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const EVIDENCE_ID = /^zbx:(event|trigger|metric):[\w.:-]+$/;

interface DiscoveredHost {
  hostId: string;
  groupIds: string[];
  itemIds: string[];
  /** First ranked numeric item, used wherever a single metric is enough. */
  primaryItemId: string;
}

function first<T>(items: T[], what: string): T {
  const value = items[0];
  if (value === undefined) {
    throw new Error(`Expected at least one ${what}`);
  }
  return value;
}

describe.skipIf(!enabled)("live Zabbix integration", () => {
  let service: ZabbixService;
  let client: ZabbixClient;
  let target: DiscoveredHost;
  let now: number;

  beforeAll(async () => {
    client = new ZabbixClient(
      { url: apiUrl!, apiToken: apiToken!, timeoutMs: 30_000 },
      new Logger("error"),
    );
    service = new ZabbixService(client, policy);
    now = Date.now();

    const found = (await service.findHosts({
      query: hostQuery!,
      limit: 5,
    })) as {
      hosts: Array<{
        host_id: string;
        groups: Array<{ group_id: string }>;
      }>;
    };
    const host = found.hosts[0];
    if (!host) {
      throw new Error(
        `No Zabbix host matched ZABBIX_INTEGRATION_HOST=${hostQuery}`,
      );
    }

    const metrics = (await service.listRelevantMetrics({
      host_id: host.host_id,
      keywords: ["cpu", "memory", "disk", "network"],
      limit: 10,
    })) as { metrics: Array<{ item_id: string }> };
    const itemIds = metrics.metrics.map((metric) => metric.item_id);

    target = {
      hostId: host.host_id,
      groupIds: host.groups.map((group) => group.group_id),
      itemIds,
      primaryItemId: first(itemIds, `numeric item on host ${host.host_id}`),
    };
  }, 60_000);

  describe("the Zabbix API this MCP was written against", () => {
    it("is at least 6.4, the floor for the fields and auth this server relies on", async () => {
      // apiinfo.version must be called *without* credentials; Zabbix rejects it
      // outright when an Authorization header is present, so this cannot go
      // through ZabbixClient.
      const response = await fetch(apiUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json-rpc" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "apiinfo.version",
          params: {},
          id: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as { result?: string };
      const version = payload.result ?? "";
      const parts = version.split(".").map(Number);
      const major = parts[0] ?? 0;
      const minor = parts[1] ?? 0;

      expect(
        major > 6 || (major === 6 && minor >= 4),
        `Zabbix ${version} is older than the 6.4 this MCP requires for Bearer auth and cause_eventid`,
      ).toBe(true);
    });

    it("accepts the Bearer token scheme the client sends", async () => {
      // A 6.0-era server would ignore the header and demand an `auth` body
      // parameter, so an authenticated call succeeding proves the 6.4+ path.
      await expect(
        client.request("host.get", { output: ["hostid"], limit: 1 }),
      ).resolves.toBeTruthy();
    });
  });

  describe("find_hosts", () => {
    it("returns candidates with the group membership the allowlist relies on", async () => {
      const result = (await service.findHosts({
        query: hostQuery!,
        limit: 5,
      })) as {
        tool_call_id: string;
        hosts: Array<Record<string, unknown>>;
      };

      expect(result.tool_call_id).toBeTruthy();
      expect(result.hosts.length).toBeGreaterThan(0);
      for (const host of result.hosts) {
        expect(host).toMatchObject({
          host_id: expect.stringMatching(/^\d+$/),
          status: expect.stringMatching(/^(monitored|not_monitored)$/),
        });
        expect(Array.isArray(host.groups)).toBe(true);
      }
    });

    // Round trip through a group the target host really belongs to, so this
    // needs no configuration of its own: whatever the search returned tells us
    // which group to list, and the host must come back out of it.
    it("lists the hosts of a group without a name to search on", async () => {
      const found = (await service.findHosts({ query: hostQuery!, limit: 1 })) as {
        hosts: Array<{ host_id: string; groups: Array<{ group_id: string }> }>;
      };
      const groupId = found.hosts[0]?.groups[0]?.group_id;
      if (!groupId) {
        return;
      }

      const listed = (await service.findHosts({
        group_ids: [groupId],
        limit: 50,
      })) as {
        hosts: Array<{ host_id: string }>;
        group_ids: string[] | null;
        query: string | null;
        result_count: number;
      };

      expect(listed.query).toBeNull();
      expect(listed.group_ids).toEqual([groupId]);
      expect(listed.result_count).toBe(listed.hosts.length);
      expect(listed.hosts.map((host) => host.host_id)).toContain(
        found.hosts[0]!.host_id,
      );
    });
  });

  describe("list_relevant_metrics", () => {
    it("returns only numeric items, ranked by descending relevance", async () => {
      const result = (await service.listRelevantMetrics({
        host_id: target.hostId,
        keywords: ["cpu", "memory"],
        limit: 10,
      })) as {
        metrics: Array<{ value_type: string; relevance_score: number }>;
      };

      expect(result.metrics.length).toBeGreaterThan(0);
      const scores = result.metrics.map((metric) => metric.relevance_score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      for (const metric of result.metrics) {
        expect(metric.relevance_score).toBeGreaterThan(0);
        expect(["numeric_float", "numeric_unsigned"]).toContain(
          metric.value_type,
        );
      }
    });
  });

  describe("get_metric_summary", () => {
    it("reports well-formed statistics and data quality", async () => {
      const result = (await service.getMetricSummary({
        host_id: target.hostId,
        item_ids: target.itemIds.slice(0, 3),
        time_from: iso(now - 2 * HOUR_MS),
        time_to: iso(now),
        aggregation: "5m",
        include_points: false,
      })) as {
        series: Array<{
          evidence_id: string;
          summary: { min: number | null; avg: number | null; max: number | null };
          data_quality: Record<string, unknown>;
        }>;
      };

      expect(result.series.length).toBeGreaterThan(0);
      for (const entry of result.series) {
        expect(entry.evidence_id).toMatch(EVIDENCE_ID);
        expect(["history", "trends"]).toContain(
          entry.data_quality.data_source,
        );
        expect(typeof entry.data_quality.partial).toBe("boolean");

        const coverage = entry.data_quality.coverage_ratio as number | null;
        if (coverage !== null) {
          expect(coverage).toBeGreaterThanOrEqual(0);
          expect(coverage).toBeLessThanOrEqual(1);
        }

        const { min, avg, max } = entry.summary;
        if (min !== null && avg !== null && max !== null) {
          expect(min).toBeLessThanOrEqual(avg);
          expect(avg).toBeLessThanOrEqual(max);
        }
      }
    });

    it("derives statistics from the full window rather than the returned points", async () => {
      // The core promise of this server: the LLM never recomputes statistics, so
      // what the MCP reports must match the raw Zabbix values it aggregated.
      const itemId = target.primaryItemId;
      const from = now - 2 * HOUR_MS;

      const summary = (await service.getMetricSummary({
        host_id: target.hostId,
        item_ids: [itemId],
        time_from: iso(from),
        time_to: iso(now),
        aggregation: "5m",
        data_source: "history",
        include_points: false,
      })) as {
        series: Array<{
          summary: { min: number | null; max: number | null };
          data_quality: { sample_count: number };
        }>;
      };
      const reported = first(summary.series, "metric series");

      const rows = await client.request<Array<{ value: string }>>(
        "history.get",
        {
          history: 0,
          itemids: [itemId],
          time_from: Math.floor(from / 1_000),
          time_till: Math.floor(now / 1_000),
          output: ["itemid", "clock", "value"],
          sortfield: ["clock"],
          sortorder: "ASC",
          limit: 50_000,
        },
      );

      if (rows.length === 0) {
        // Float items land in history table 0; an unsigned item would need a
        // different `history` value. Nothing to cross-check here.
        expect(reported.data_quality.sample_count).toBe(0);
        return;
      }

      const raw = rows.map((row) => Number(row.value)).filter(Number.isFinite);
      expect(reported.data_quality.sample_count).toBe(rows.length);
      // Bucket min/max are exact over the whole window, unlike the average which
      // is re-weighted per bucket.
      expect(reported.summary.min).toBeCloseTo(Math.min(...raw), 4);
      expect(reported.summary.max).toBeCloseTo(Math.max(...raw), 4);
    });

    it("marks a window the source data barely covers as partial", async () => {
      // Trends are written hourly, so a 24h window at 1h aggregation exposes
      // whatever retention actually exists behind the request.
      const result = (await service.getMetricSummary({
        host_id: target.hostId,
        item_ids: [target.primaryItemId],
        time_from: iso(now - 25 * HOUR_MS),
        time_to: iso(now),
        aggregation: "1h",
        include_points: false,
      })) as {
        series: Array<{
          data_quality: { coverage_ratio: number | null; partial: boolean };
        }>;
      };
      const quality = first(result.series, "metric series").data_quality;

      if (quality.coverage_ratio !== null) {
        expect(quality.partial).toBe(
          quality.coverage_ratio < policy.minCoverageRatio,
        );
      }
    });
  });

  describe("get_metric_history", () => {
    it("honours the point ceiling and stamps a traceable evidence id", async () => {
      const result = (await service.getMetricHistory({
        host_id: target.hostId,
        item_id: target.primaryItemId,
        time_from: iso(now - 2 * HOUR_MS),
        time_to: iso(now),
        aggregation: "5m",
        max_points: 100,
      })) as {
        evidence_id: string;
        points: Array<{ time: string; count: number }>;
        data_quality: Record<string, unknown>;
      };

      expect(result.evidence_id).toMatch(EVIDENCE_ID);
      expect(result.points.length).toBeLessThanOrEqual(100);
      expect(result.data_quality.data_source).toBe("history");

      const times = result.points.map((point) => Date.parse(point.time));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const point of result.points) {
        expect(point.count).toBeGreaterThan(0);
      }
    });
  });

  describe("get_incident_events and get_trigger_details", () => {
    it("links problems to recoveries and exposes trigger definitions", async () => {
      const events = (await service.getIncidentEvents({
        host_id: target.hostId,
        time_from: iso(now - 24 * HOUR_MS),
        time_to: iso(now),
        include_recovery: true,
        limit: 20,
      })) as {
        events: Array<{
          evidence_id: string;
          trigger_id: string;
          severity: string;
          started_at: string;
          recovered_at: string | null;
        }>;
        result_count: number;
        partial: boolean;
      };

      expect(events.result_count).toBe(events.events.length);
      expect(events.partial).toBe(false);

      if (events.events.length === 0) {
        return; // a healthy host in the window is a valid outcome
      }

      for (const event of events.events) {
        expect(event.evidence_id).toMatch(EVIDENCE_ID);
        expect(Date.parse(event.started_at)).not.toBeNaN();
        if (event.recovered_at !== null) {
          expect(Date.parse(event.recovered_at)).toBeGreaterThanOrEqual(
            Date.parse(event.started_at),
          );
        }
      }

      const trigger = (await service.getTriggerDetails({
        trigger_id: first(events.events, "incident event").trigger_id,
      })) as {
        evidence_id: string;
        expression: string;
        hosts: Array<{ host_id: string }>;
      };
      expect(trigger.evidence_id).toMatch(EVIDENCE_ID);
      expect(trigger.expression).toBeTruthy();
      expect(trigger.hosts.length).toBeGreaterThan(0);
    });
  });

  describe("get_related_events", () => {
    it("returns a bounded, well-formed event list", async () => {
      const result = (await service.getRelatedEvents({
        host_id: target.hostId,
        time_from: iso(now - 24 * HOUR_MS),
        time_to: iso(now),
        limit: 20,
      })) as { events: Array<{ evidence_id: string }>; result_count: number };

      expect(result.events.length).toBeLessThanOrEqual(20);
      expect(result.result_count).toBe(result.events.length);
      for (const event of result.events) {
        expect(event.evidence_id).toMatch(EVIDENCE_ID);
      }
    });
  });

  describe("policy guardrails", () => {
    it("rejects a window wider than the standard policy", async () => {
      await expect(
        service.getIncidentEvents({
          host_id: target.hostId,
          time_from: iso(now - 48 * HOUR_MS),
          time_to: iso(now),
        }),
      ).rejects.toMatchObject({ code: "TIME_RANGE_LIMIT_EXCEEDED" });
    });

    it("rejects an inverted window", async () => {
      await expect(
        service.getIncidentEvents({
          host_id: target.hostId,
          time_from: iso(now),
          time_to: iso(now - HOUR_MS),
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIME_RANGE" });
    });

    it("rejects a timestamp without a timezone", async () => {
      await expect(
        service.getIncidentEvents({
          host_id: target.hostId,
          time_from: "2026-07-30 00:00:00",
          time_to: "2026-07-30 01:00:00",
        }),
      ).rejects.toMatchObject({ code: "INVALID_TIME" });
    });

    it("rejects a window too far in the future", async () => {
      await expect(
        service.getIncidentEvents({
          host_id: target.hostId,
          time_from: iso(now + 5 * HOUR_MS),
          time_to: iso(now + 6 * HOUR_MS),
        }),
      ).rejects.toMatchObject({ code: "FUTURE_TIME_LIMIT_EXCEEDED" });
    });

    it("refuses trends at an aggregation finer than one hour", async () => {
      await expect(
        service.getMetricSummary({
          host_id: target.hostId,
          item_ids: [target.primaryItemId],
          time_from: iso(now - 6 * HOUR_MS),
          time_to: iso(now),
          aggregation: "5m",
          data_source: "trends",
        }),
      ).rejects.toMatchObject({ code: "AGGREGATION_TOO_FINE" });
    });

    it("refuses raw history under the long-term capacity policy", async () => {
      await expect(
        service.getMetricSummary({
          host_id: target.hostId,
          item_ids: [target.primaryItemId],
          time_from: iso(now - 6 * HOUR_MS),
          time_to: iso(now),
          aggregation: "1h",
          policy: "long_term_capacity",
          data_source: "history",
        }),
      ).rejects.toMatchObject({ code: "HISTORY_NOT_ALLOWED" });
    });

    it("refuses more items than a single call allows", async () => {
      await expect(
        service.getMetricSummary({
          host_id: target.hostId,
          item_ids: Array.from({ length: policy.maxItemsPerCall + 1 }, (_, i) =>
            String(1_000_000 + i),
          ),
          time_from: iso(now - HOUR_MS),
          time_to: iso(now),
          aggregation: "5m",
        }),
      ).rejects.toMatchObject({ code: "ITEM_LIMIT_EXCEEDED" });
    });

    it("refuses an aggregation that would blow the point ceiling", async () => {
      await expect(
        service.getMetricHistory({
          host_id: target.hostId,
          item_id: target.primaryItemId,
          time_from: iso(now - 24 * HOUR_MS),
          time_to: iso(now),
          aggregation: "1m",
          max_points: 100,
        }),
      ).rejects.toMatchObject({ code: "RESULT_POINT_LIMIT_EXCEEDED" });
    });
  });

  describe("host group allowlist", () => {
    it("serves a host inside the allowlist and blocks one outside it", async () => {
      const restricted = new ZabbixService(client, {
        ...policy,
        allowedHostGroupIds: target.groupIds,
      });

      await expect(
        restricted.getIncidentEvents({
          host_id: target.hostId,
          time_from: iso(now - HOUR_MS),
          time_to: iso(now),
        }),
      ).resolves.toBeTruthy();

      const walledOff = new ZabbixService(client, {
        ...policy,
        allowedHostGroupIds: ["-1"],
      });
      await expect(
        walledOff.getIncidentEvents({
          host_id: target.hostId,
          time_from: iso(now - HOUR_MS),
          time_to: iso(now),
        }),
      ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED", status: 403 });
    });
  });
});
