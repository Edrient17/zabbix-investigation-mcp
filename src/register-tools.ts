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
        "Resolve which hosts to investigate. Give query to search allowlisted hosts by technical or display name. Give group_ids to list the hosts belonging to those host groups, which is how an investigation covering a whole estate finds its subjects when the request names no host. Both may be given together to search within groups. At least one is required. Never choose a host when several plausible candidates remain for one name.",
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
        "Retrieve trigger problem events and their recovery events for one host in a bounded time window. Use this before selecting detailed metrics.",
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
        "Rank numeric items on a host using incident-specific keywords. The investigation Agent chooses the keywords; this tool performs deterministic catalog filtering and ranking.",
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
        "Retrieve and deterministically aggregate numeric metrics, returning per-series statistics: min, max, avg, first, last, change percent and trend. This is the survey step -- read the statistics, and call get_metric_history for the one metric whose shape you then need to see. Use long_term_capacity only for capacity or slow trend analysis and use at least 1h aggregation. include_points adds every aggregated bucket to the response and is off by default: the buckets are large, they stay in the conversation for the rest of the investigation, and get_metric_history already returns them for a chosen metric.",
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
        "Retrieve detailed history for one numeric metric after a summary has identified an interesting interval. Choose a coarser aggregation if the point limit would be exceeded.",
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
        "Call a Zabbix `.get` method with your own parameters, for the field or object the tools above do not cover -- host inventory, item configuration, template contents, or auditlog.get to find out who changed Zabbix shortly before an alert. " +
        "Prefer the tools above when one fits: they aggregate, they bound the reply, and they return figures already computed. This returns raw API output, so you pay for the fields you ask for -- name them in `output` rather than taking everything. " +
        "Only `.get` methods are reachable; nothing here can modify Zabbix. Results stay inside this deployment's host group allowlist, which is applied to the query itself, and both the row count and the reply size are capped. " +
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
