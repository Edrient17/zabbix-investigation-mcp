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
/**
 * How every host-scoped tool takes its host.
 *
 * The id is Zabbix's own handle. The name is what the rest of the estate calls
 * the same machine, so a caller holding only a name -- from a log line, an agent
 * list, the person who reported it -- can still reach these tools. The server
 * resolves the name, because two of the Zabbix methods underneath reject one and
 * knowing which is not the caller's problem.
 */
const hostRef = {
  host_id: zabbixId
    .optional()
    .describe("Zabbix host id, as returned by find_hosts."),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Host name, matched exactly against both the technical and the visible name. A name matching several hosts is an error rather than a guess. Give either host_id or host.",
    ),
};
const isoTime = z.iso
  .datetime({ offset: true })
  .describe("ISO 8601 date-time including Z or an explicit UTC offset");
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
  const rawMethod = z
    .enum(offeredMethods as [string, ...string[]])
    .describe("Read-only Zabbix API method allowed by this deployment");
  server.registerTool(
    "find_hosts",
    {
      title: "Find Zabbix hosts",
      description:
        "Resolve technical or display host names to Zabbix host IDs. query searches allowlisted hosts; group_ids lists hosts in those groups; both together search within the groups. At least one is required. Returns every match, including ambiguous matches.",
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
        "Retrieve trigger problem events and their recovery events for one host in a time window. Identify the host by host_id or by host name. Filter by severity; include_recovery controls whether recovery events are paired in. Months-long windows need policy long_term_capacity. The reply carries partial, which is true when the row limit was reached and the count is therefore a floor.",
      inputSchema: {
        ...hostRef,
        time_from: isoTime,
        time_to: isoTime,
        severities: z.array(severity).max(6).optional(),
        include_recovery: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).optional(),
        policy: z
          .enum(["standard", "long_term_capacity"])
          .default("standard")
          .describe(
            "long_term_capacity widens the window for questions that span months. "
            + "The reply is still capped at the row limit, and partial says whether it was reached.",
          ),
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
        "Rank a host's numeric items against supplied keywords by item name and key. Identify the host by host_id or by host name. Returns item_id, name, key, value type and units for the highest-ranked matches.",
      inputSchema: {
        ...hostRef,
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
        "Aggregate numeric metrics over a window, returning per-series min, max, average, first, last, change percent and trend. Identify the host by host_id or by host name. Takes up to 20 item_ids and an aggregation interval. The long_term_capacity policy reads trend data and requires an interval of at least 1h. include_points adds aggregated buckets and is disabled by default.",
      inputSchema: {
        ...hostRef,
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
        "Retrieve the aggregated points for a single numeric item over a window. Identify the host by host_id or by host name. Takes one item_id and an optional max_points; exceeding the point limit is an error rather than a silent truncation.",
      inputSchema: {
        ...hostRef,
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
        "Retrieve neighboring problem and recovery events on the same host, optionally restricted by trigger IDs or exact tags. Identify the host by host_id or by host name. Months-long windows need policy long_term_capacity; partial is true when the row limit was reached.",
      inputSchema: {
        ...hostRef,
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
        policy: z
          .enum(["standard", "long_term_capacity"])
          .default("standard")
          .describe(
            "long_term_capacity widens the window for questions that span months. "
            + "The reply is still capped at the row limit, and partial says whether it was reached.",
          ),
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
        method: rawMethod,
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
