import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { errorPayload } from "./errors.js";
import { allowedMethods, selectMethods } from "./raw-query.js";
import { aggregationValues } from "./types.js";
import type { ZabbixService } from "./zabbix-service.js";

const zabbixId = z
  .string()
  .regex(/^\d+$/, "Zabbix IDs must contain decimal digits only");
const isoTime = z
  .string()
  .describe("ISO 8601 timestamp including Z or an explicit UTC offset");
const aggregation = z.enum(aggregationValues);
const summaryAggregation = z.enum([
  "1m",
  "5m",
  "15m",
  "1h",
  "6h",
  "1d",
]);
const severity = z.enum([
  "not_classified",
  "information",
  "warning",
  "average",
  "high",
  "disaster",
]);

async function resultOf(
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const payload = errorPayload(error);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

export function registerTools(
  server: McpServer,
  service: ZabbixService,
  // What this deployment's Zabbix role will answer. The description names the
  // methods, so it has to name the ones that exist here rather than the ones
  // the code knows how to confine.
  rawQueryMethods: string[] = [],
): void {
  const offeredMethods = allowedMethods(selectMethods(rawQueryMethods));
  server.registerTool(
    "find_hosts",
    {
      title: "Find Zabbix hosts",
      description:
        "Resolve host names to Zabbix host IDs, which the other tools take. query searches allowlisted hosts by technical or display name; group_ids lists the hosts in those host groups; both together search within the groups. At least one is required. Returns every match, including several for one query.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional(),
        group_ids: z.array(zabbixId).min(1).max(20).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    (input) => resultOf(() => service.findHosts(input)),
  );

  server.registerTool(
    "get_incident_events",
    {
      title: "Get incident events",
      description:
        "Retrieve trigger problem events and their recovery events for one host in a bounded time window. Filter by severity; include_recovery controls whether recovery events are paired in.",
      inputSchema: {
        host_id: zabbixId,
        time_from: isoTime,
        time_to: isoTime,
        severities: z.array(severity).max(6).optional(),
        include_recovery: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    (input) => resultOf(() => service.getIncidentEvents(input)),
  );

  server.registerTool(
    "get_trigger_details",
    {
      title: "Get trigger details",
      description:
        "Retrieve a read-only trigger definition, related items, dependencies, tags, and operational description.",
      inputSchema: {
        trigger_id: zabbixId,
      },
    },
    (input) => resultOf(() => service.getTriggerDetails(input)),
  );

  server.registerTool(
    "list_relevant_metrics",
    {
      title: "List relevant numeric metrics",
      description:
        "Rank a host's numeric items against the supplied keywords, matching item name and key. Returns item_id, name, key, value type and units for the highest ranked, which the metric tools then take.",
      inputSchema: {
        host_id: zabbixId,
        keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    (input) => resultOf(() => service.listRelevantMetrics(input)),
  );

  server.registerTool(
    "get_metric_summary",
    {
      title: "Get aggregated metric summaries",
      description:
        "Aggregate numeric metrics over a window, returning per-series statistics: min, max, avg, first, last, change percent and trend. Takes item_ids (up to 20) and an aggregation interval. The long_term_capacity policy reads trend data instead of history and requires an interval of 1h or more. include_points adds every aggregated bucket to the reply and is off by default; get_metric_history returns those points for a single item.",
      inputSchema: {
        host_id: zabbixId,
        item_ids: z.array(zabbixId).min(1).max(20),
        time_from: isoTime,
        time_to: isoTime,
        aggregation: summaryAggregation,
        policy: z
          .enum(["standard", "long_term_capacity"])
          .default("standard"),
        data_source: z
          .enum(["auto", "history", "trends"])
          .default("auto"),
        include_points: z.boolean().default(false),
      },
    },
    (input) => resultOf(() => service.getMetricSummary(input)),
  );

  server.registerTool(
    "get_metric_history",
    {
      title: "Get detailed metric history",
      description:
        "Retrieve the aggregated points for a single numeric item over a window. Takes one item_id and an optional max_points; exceeding the point limit is an error rather than a silent truncation.",
      inputSchema: {
        host_id: zabbixId,
        item_id: zabbixId,
        time_from: isoTime,
        time_to: isoTime,
        aggregation,
        max_points: z.number().int().min(1).max(1_000).optional(),
      },
    },
    (input) => resultOf(() => service.getMetricHistory(input)),
  );

  server.registerTool(
    "get_related_events",
    {
      title: "Get related events",
      description:
        "Retrieve neighboring problem and recovery events on the same host, optionally restricted by trigger IDs or exact tags.",
      inputSchema: {
        host_id: zabbixId,
        time_from: isoTime,
        time_to: isoTime,
        exclude_event_id: zabbixId.optional(),
        trigger_ids: z.array(zabbixId).max(100).optional(),
        tags: z
          .array(
            z.object({
              tag: z.string().trim().min(1).max(255),
              value: z.string().max(255),
            }),
          )
          .max(20)
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    (input) => resultOf(() => service.getRelatedEvents(input)),
  );

  server.registerTool(
    "query_zabbix",
    {
      title: "Read any allowed Zabbix object directly",
      description:
        "Call a Zabbix `.get` method directly with your own parameters and receive the raw API rows. Only `.get` methods are reachable, so nothing here can modify Zabbix. " +
        "Group-scoped methods have this deployment's host group allowlist intersected into the query; naming a group outside it is an error rather than an empty result. Host-scoped methods require hostids. " +
        "The reply is capped by row count and by size, and params_applied reports the query as actually sent. Naming fields in `output` reduces the reply. " +
        "Allowed methods: " + offeredMethods.join(", ") + ".",
      inputSchema: {
        method: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .describe("Zabbix API method, e.g. host.get or auditlog.get"),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Parameters for the method, exactly as the Zabbix API documents them. Set `output` to the fields you actually need. `groupids` is intersected with the allowlist; `limit` is capped.",
          ),
      },
    },
    (input) => resultOf(() => service.rawQuery(input)),
  );
}
