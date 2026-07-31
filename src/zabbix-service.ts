import { randomUUID } from "node:crypto";
import {
  aggregateHistory,
  aggregateTrends,
  coverageRatio,
  expectedBucketCount,
  summarizeSeries,
} from "./aggregation.js";
import { AppError } from "./errors.js";
import {
  clampLimit,
  getAggregationSeconds,
  validateWindow,
} from "./policies.js";
import type {
  Aggregation,
  MetricDataSource,
  NumericPoint,
  QueryPolicy,
  QueryPolicyName,
  TimeWindow,
  TrendPoint,
  ZabbixApi,
} from "./types.js";

interface ZabbixHostGroup {
  groupid: string;
  name: string;
}

interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: string;
  hostgroups?: ZabbixHostGroup[];
}

interface ZabbixAcknowledge {
  acknowledgeid?: string;
  userid: string;
  clock: string;
  message?: string;
  action: string;
}

interface ZabbixTag {
  tag: string;
  value: string;
}

interface ZabbixEvent {
  eventid: string;
  objectid: string;
  clock: string;
  name: string;
  severity: string;
  value: string;
  acknowledged?: string;
  r_eventid?: string;
  cause_eventid?: string;
  suppressed?: string;
  acknowledges?: ZabbixAcknowledge[];
  tags?: ZabbixTag[];
  suppression_data?: unknown[];
}

interface ZabbixItem {
  itemid: string;
  hostid: string;
  name: string;
  key_: string;
  value_type: string;
  units: string;
  status: string;
  state?: string;
  delay?: string;
  history?: string;
  trends?: string;
  lastclock?: string;
  lastvalue?: string;
  tags?: ZabbixTag[];
}

interface ZabbixTriggerFunction {
  functionid: string;
  itemid: string;
  function: string;
  parameter: string;
}

interface ZabbixTriggerDependency {
  triggerid: string;
  description: string;
}

interface ZabbixTrigger {
  triggerid: string;
  description: string;
  expression: string;
  recovery_expression?: string;
  priority: string;
  status: string;
  value: string;
  comments?: string;
  opdata?: string;
  manual_close?: string;
  hosts?: Array<Pick<ZabbixHost, "hostid" | "host" | "name">>;
  functions?: ZabbixTriggerFunction[];
  dependencies?: ZabbixTriggerDependency[];
  tags?: ZabbixTag[];
}

interface ZabbixHistoryValue {
  itemid: string;
  clock: string;
  ns?: string;
  value: string;
}

interface ZabbixTrendValue {
  itemid: string;
  clock: string;
  num: string;
  value_min: string;
  value_avg: string;
  value_max: string;
}

const severityToNumber = {
  not_classified: 0,
  information: 1,
  warning: 2,
  average: 3,
  high: 4,
  disaster: 5,
} as const;

const numberToSeverity = [
  "not_classified",
  "information",
  "warning",
  "average",
  "high",
  "disaster",
] as const;

export type Severity = keyof typeof severityToNumber;

export interface FindHostsInput {
  query: string;
  limit?: number;
}

export interface GetIncidentEventsInput {
  host_id: string;
  time_from: string;
  time_to: string;
  severities?: Severity[];
  include_recovery?: boolean;
  limit?: number;
}

export interface GetTriggerDetailsInput {
  trigger_id: string;
}

export interface ListRelevantMetricsInput {
  host_id: string;
  keywords: string[];
  limit?: number;
}

export interface GetMetricHistoryInput {
  host_id: string;
  item_id: string;
  time_from: string;
  time_to: string;
  aggregation: Aggregation;
  max_points?: number;
}

export interface GetMetricSummaryInput {
  host_id: string;
  item_ids: string[];
  time_from: string;
  time_to: string;
  aggregation: Exclude<Aggregation, "raw">;
  policy?: QueryPolicyName;
  data_source?: MetricDataSource;
  include_points?: boolean;
}

export interface GetRelatedEventsInput {
  host_id: string;
  time_from: string;
  time_to: string;
  exclude_event_id?: string;
  trigger_ids?: string[];
  tags?: ZabbixTag[];
  limit?: number;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(clock: string): string {
  return new Date(Number.parseInt(clock, 10) * 1_000).toISOString();
}

function severityName(value: string): (typeof numberToSeverity)[number] {
  return numberToSeverity[Number.parseInt(value, 10)] ?? "not_classified";
}

function evidenceId(
  type: "event" | "trigger" | "metric",
  id: string,
  suffix?: string,
): string {
  return `zbx:${type}:${id}${suffix ? `:${suffix}` : ""}`;
}

export class ZabbixService {
  constructor(
    private readonly api: ZabbixApi,
    private readonly policy: QueryPolicy,
  ) {}

  async findHosts(input: FindHostsInput): Promise<Record<string, unknown>> {
    const limit = clampLimit(input.limit, 50, 10);
    const params: Record<string, unknown> = {
      output: ["hostid", "host", "name", "status"],
      selectHostGroups: ["groupid", "name"],
      search: {
        host: input.query,
        name: input.query,
      },
      searchByAny: true,
      sortfield: "name",
      limit,
    };

    if (this.policy.allowedHostGroupIds.length > 0) {
      params.groupids = this.policy.allowedHostGroupIds;
    }

    const hosts = await this.api.request<ZabbixHost[]>("host.get", params);
    return {
      tool_call_id: randomUUID(),
      query: input.query,
      hosts: hosts.map((host) => ({
        host_id: host.hostid,
        host: host.host,
        name: host.name,
        status: host.status === "0" ? "monitored" : "not_monitored",
        groups: (host.hostgroups ?? []).map((group) => ({
          group_id: group.groupid,
          name: group.name,
        })),
      })),
    };
  }

  async getIncidentEvents(
    input: GetIncidentEventsInput,
  ): Promise<Record<string, unknown>> {
    await this.assertHostAllowed(input.host_id);
    const window = validateWindow(
      { from: input.time_from, to: input.time_to },
      "standard",
      this.policy,
      "1m",
    );
    const limit = clampLimit(input.limit, this.policy.maxEvents, 100);
    const events = await this.fetchProblemEvents({
      hostId: input.host_id,
      window: { from: input.time_from, to: input.time_to },
      severities: input.severities,
      limit,
    });
    const recoveryEvents =
      input.include_recovery === false
        ? new Map<string, ZabbixEvent>()
        : await this.fetchRecoveries(events);

    return {
      tool_call_id: randomUUID(),
      host_id: input.host_id,
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      events: events.map((event) =>
        this.mapEvent(event, recoveryEvents.get(event.r_eventid ?? "")),
      ),
      result_count: events.length,
      partial: events.length === limit,
    };
  }

  async getTriggerDetails(
    input: GetTriggerDetailsInput,
  ): Promise<Record<string, unknown>> {
    const triggers = await this.api.request<ZabbixTrigger[]>("trigger.get", {
      triggerids: [input.trigger_id],
      output: [
        "triggerid",
        "description",
        "expression",
        "recovery_expression",
        "priority",
        "status",
        "value",
        "comments",
        "opdata",
        "manual_close",
      ],
      selectHosts: ["hostid", "host", "name"],
      selectFunctions: "extend",
      selectDependencies: ["triggerid", "description"],
      selectTags: "extend",
    });
    const trigger = triggers[0];
    if (!trigger) {
      throw new AppError("TRIGGER_NOT_FOUND", "Trigger was not found");
    }

    const hosts = trigger.hosts ?? [];
    if (hosts.length === 0) {
      throw new AppError(
        "TRIGGER_WITHOUT_HOST",
        "Trigger is not associated with a visible host",
      );
    }
    for (const host of hosts) {
      await this.assertHostAllowed(host.hostid);
    }

    const itemIds = [
      ...new Set((trigger.functions ?? []).map((entry) => entry.itemid)),
    ];
    const items =
      itemIds.length === 0
        ? []
        : await this.api.request<ZabbixItem[]>("item.get", {
            itemids: itemIds,
            output: [
              "itemid",
              "hostid",
              "name",
              "key_",
              "value_type",
              "units",
              "status",
            ],
          });

    return {
      tool_call_id: randomUUID(),
      evidence_id: evidenceId("trigger", trigger.triggerid),
      trigger_id: trigger.triggerid,
      description: trigger.description,
      severity: severityName(trigger.priority),
      expression: trigger.expression,
      recovery_expression: trigger.recovery_expression || null,
      status: trigger.status === "0" ? "enabled" : "disabled",
      current_value: trigger.value === "1" ? "problem" : "ok",
      comments: trigger.comments || null,
      operational_data: trigger.opdata || null,
      manual_close_allowed: trigger.manual_close === "1",
      hosts: hosts.map((host) => ({
        host_id: host.hostid,
        host: host.host,
        name: host.name,
      })),
      functions: trigger.functions ?? [],
      items: items.map((item) => this.mapItem(item)),
      dependencies: trigger.dependencies ?? [],
      tags: trigger.tags ?? [],
    };
  }

  async listRelevantMetrics(
    input: ListRelevantMetricsInput,
  ): Promise<Record<string, unknown>> {
    await this.assertHostAllowed(input.host_id);
    const limit = clampLimit(input.limit, 100, 30);
    const items = await this.api.request<ZabbixItem[]>("item.get", {
      hostids: [input.host_id],
      output: [
        "itemid",
        "hostid",
        "name",
        "key_",
        "value_type",
        "units",
        "status",
        "state",
        "delay",
        "history",
        "trends",
        "lastclock",
        "lastvalue",
      ],
      filter: {
        status: "0",
        value_type: ["0", "3"],
      },
      selectTags: "extend",
      limit: Math.min(5_000, this.policy.maxSourcePoints),
    });

    const normalizedKeywords = input.keywords
      .map((keyword) => keyword.trim().toLocaleLowerCase())
      .filter(Boolean);
    const ranked = items
      .map((item) => ({
        item,
        score: this.metricRelevance(item, normalizedKeywords),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.item.name.localeCompare(right.item.name),
      )
      .slice(0, limit);

    return {
      tool_call_id: randomUUID(),
      host_id: input.host_id,
      keywords: normalizedKeywords,
      metrics: ranked.map(({ item, score }) => ({
        ...this.mapItem(item),
        relevance_score: score,
        last_clock: item.lastclock && item.lastclock !== "0"
          ? toIso(item.lastclock)
          : null,
        last_value: item.lastvalue || null,
        history_retention: item.history || null,
        trends_retention: item.trends || null,
      })),
      result_count: ranked.length,
      catalog_truncated: items.length === Math.min(5_000, this.policy.maxSourcePoints),
    };
  }

  async getMetricHistory(
    input: GetMetricHistoryInput,
  ): Promise<Record<string, unknown>> {
    const window = validateWindow(
      { from: input.time_from, to: input.time_to },
      "standard",
      this.policy,
      input.aggregation,
    );
    const [item] = await this.getNumericItems(input.host_id, [input.item_id]);
    if (!item) {
      throw new AppError("ITEM_NOT_FOUND", "Metric item was not found");
    }

    const maximumPoints = clampLimit(
      input.max_points,
      this.policy.maxHistoryPoints,
      this.policy.maxHistoryPoints,
    );
    const interval = getAggregationSeconds(input.aggregation);
    const expected = expectedBucketCount(
      window.fromEpoch,
      window.toEpoch,
      interval,
    );
    if (expected !== null && expected > maximumPoints) {
      throw new AppError(
        "RESULT_POINT_LIMIT_EXCEEDED",
        "Requested aggregation would return too many points; choose a coarser interval",
        {
          details: {
            expected_points: expected,
            maximum_points: maximumPoints,
          },
        },
      );
    }

    const history = await this.fetchHistory(item, window);
    const allPoints = aggregateHistory(
      history.points,
      window.fromEpoch,
      window.toEpoch,
      interval,
    );
    const points = allPoints.slice(0, maximumPoints);
    const partial = history.partial || points.length < allPoints.length;

    return {
      tool_call_id: randomUUID(),
      evidence_id: evidenceId(
        "metric",
        item.itemid,
        `${window.fromEpoch}-${window.toEpoch}-${input.aggregation}`,
      ),
      host_id: input.host_id,
      item: this.mapItem(item),
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      aggregation: input.aggregation,
      points,
      summary: summarizeSeries(allPoints),
      data_quality: {
        data_source: "history",
        sample_count: history.points.length,
        returned_points: points.length,
        expected_buckets: expected,
        coverage_ratio: coverageRatio(allPoints.length, expected),
        partial,
      },
    };
  }

  async getMetricSummary(
    input: GetMetricSummaryInput,
  ): Promise<Record<string, unknown>> {
    const policyName = input.policy ?? "standard";
    const window = validateWindow(
      { from: input.time_from, to: input.time_to },
      policyName,
      this.policy,
      input.aggregation,
    );
    const items = await this.getNumericItems(input.host_id, input.item_ids);
    const interval = getAggregationSeconds(input.aggregation);
    if (interval === null) {
      throw new AppError(
        "INVALID_AGGREGATION",
        "Metric summaries require an aggregated interval",
      );
    }

    const requestedSource = input.data_source ?? "auto";
    const selectedSource = this.selectDataSource(
      requestedSource,
      policyName,
      interval,
      window.durationSeconds,
      window.to,
    );
    const series = [];

    for (const item of items) {
      let source = selectedSource;
      let points;
      let sampleCount: number;
      let sourcePartial: boolean;

      if (source === "trends") {
        const trends = await this.fetchTrends(item, window);
        if (trends.points.length === 0 && policyName === "standard") {
          source = "history";
          const history = await this.fetchHistory(item, window);
          points = aggregateHistory(
            history.points,
            window.fromEpoch,
            window.toEpoch,
            interval,
          );
          sampleCount = history.points.length;
          sourcePartial = history.partial;
        } else {
          points = aggregateTrends(
            trends.points,
            window.fromEpoch,
            window.toEpoch,
            interval,
          );
          sampleCount = trends.points.reduce(
            (total, point) => total + point.count,
            0,
          );
          sourcePartial = trends.partial;
        }
      } else {
        const history = await this.fetchHistory(item, window);
        points = aggregateHistory(
          history.points,
          window.fromEpoch,
          window.toEpoch,
          interval,
        );
        sampleCount = history.points.length;
        sourcePartial = history.partial;
      }

      const expected = expectedBucketCount(
        window.fromEpoch,
        window.toEpoch,
        interval,
      );
      const returnedPoints = input.include_points === false
        ? []
        : points.slice(0, this.policy.maxHistoryPoints);
      const responseTruncated = returnedPoints.length < points.length &&
        input.include_points !== false;

      series.push({
        evidence_id: evidenceId(
          "metric",
          item.itemid,
          `${window.fromEpoch}-${window.toEpoch}-${input.aggregation}`,
        ),
        item: this.mapItem(item),
        summary: summarizeSeries(points),
        points: returnedPoints,
        data_quality: {
          data_source: source,
          sample_count: sampleCount,
          returned_points: returnedPoints.length,
          expected_buckets: expected,
          coverage_ratio: coverageRatio(points.length, expected),
          partial: sourcePartial || responseTruncated,
        },
      });
    }

    return {
      tool_call_id: randomUUID(),
      host_id: input.host_id,
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      aggregation: input.aggregation,
      policy: policyName,
      requested_data_source: requestedSource,
      series,
    };
  }

  async getRelatedEvents(
    input: GetRelatedEventsInput,
  ): Promise<Record<string, unknown>> {
    await this.assertHostAllowed(input.host_id);
    const window = validateWindow(
      { from: input.time_from, to: input.time_to },
      "standard",
      this.policy,
      "1m",
    );
    const limit = clampLimit(input.limit, this.policy.maxEvents, 100);
    const params: Record<string, unknown> = {
      hostids: [input.host_id],
      source: 0,
      object: 0,
      value: 1,
      time_from: window.fromEpoch,
      time_till: window.toEpoch,
      output: [
        "eventid",
        "objectid",
        "clock",
        "name",
        "severity",
        "value",
        "acknowledged",
        "r_eventid",
        "cause_eventid",
        "suppressed",
      ],
      selectTags: "extend",
      selectAcknowledges: "extend",
      selectSuppressionData: "extend",
      sortfield: ["clock", "eventid"],
      sortorder: "ASC",
      limit,
    };

    if (input.trigger_ids && input.trigger_ids.length > 0) {
      params.objectids = input.trigger_ids;
    }
    if (input.tags && input.tags.length > 0) {
      params.tags = input.tags.map((tag) => ({
        tag: tag.tag,
        value: tag.value,
        operator: 1,
      }));
      params.evaltype = 2;
    }

    const events = await this.api.request<ZabbixEvent[]>("event.get", params);
    const filtered = events.filter(
      (event) => event.eventid !== input.exclude_event_id,
    );
    const recoveries = await this.fetchRecoveries(filtered);

    return {
      tool_call_id: randomUUID(),
      host_id: input.host_id,
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      events: filtered.map((event) =>
        this.mapEvent(event, recoveries.get(event.r_eventid ?? "")),
      ),
      result_count: filtered.length,
      partial: events.length === limit,
    };
  }

  private async assertHostAllowed(hostId: string): Promise<ZabbixHost> {
    const hosts = await this.api.request<ZabbixHost[]>("host.get", {
      hostids: [hostId],
      output: ["hostid", "host", "name", "status"],
      selectHostGroups: ["groupid", "name"],
    });
    const host = hosts[0];
    if (!host) {
      throw new AppError("HOST_NOT_FOUND", "Host was not found");
    }

    if (
      this.policy.allowedHostGroupIds.length > 0 &&
      !(host.hostgroups ?? []).some((group) =>
        this.policy.allowedHostGroupIds.includes(group.groupid),
      )
    ) {
      throw new AppError(
        "HOST_NOT_ALLOWED",
        "Host is outside the configured host group allowlist",
        { status: 403, details: { host_id: hostId } },
      );
    }
    return host;
  }

  private async getNumericItems(
    hostId: string,
    itemIds: string[],
  ): Promise<ZabbixItem[]> {
    await this.assertHostAllowed(hostId);
    const uniqueIds = [...new Set(itemIds)];
    if (uniqueIds.length === 0) {
      throw new AppError("ITEMS_REQUIRED", "At least one item ID is required");
    }
    if (uniqueIds.length > this.policy.maxItemsPerCall) {
      throw new AppError(
        "ITEM_LIMIT_EXCEEDED",
        "Too many metric items were requested",
        {
          details: {
            requested: uniqueIds.length,
            maximum: this.policy.maxItemsPerCall,
          },
        },
      );
    }

    const items = await this.api.request<ZabbixItem[]>("item.get", {
      hostids: [hostId],
      itemids: uniqueIds,
      output: [
        "itemid",
        "hostid",
        "name",
        "key_",
        "value_type",
        "units",
        "status",
        "state",
        "delay",
        "history",
        "trends",
      ],
    });
    const returnedIds = new Set(items.map((item) => item.itemid));
    const missing = uniqueIds.filter((itemId) => !returnedIds.has(itemId));
    if (missing.length > 0) {
      throw new AppError(
        "ITEM_NOT_FOUND",
        "One or more metric items were not found on the requested host",
        { details: { item_ids: missing } },
      );
    }

    for (const item of items) {
      if (!["0", "3"].includes(item.value_type)) {
        throw new AppError(
          "UNSUPPORTED_VALUE_TYPE",
          "Only numeric float and numeric unsigned items can be aggregated",
          { details: { item_id: item.itemid, value_type: item.value_type } },
        );
      }
    }
    return items;
  }

  private async fetchProblemEvents(options: {
    hostId: string;
    window: TimeWindow;
    severities?: Severity[];
    limit: number;
  }): Promise<ZabbixEvent[]> {
    const window = validateWindow(
      options.window,
      "standard",
      this.policy,
      "1m",
    );
    const params: Record<string, unknown> = {
      hostids: [options.hostId],
      source: 0,
      object: 0,
      value: 1,
      time_from: window.fromEpoch,
      time_till: window.toEpoch,
      output: [
        "eventid",
        "objectid",
        "clock",
        "name",
        "severity",
        "value",
        "acknowledged",
        "r_eventid",
        "cause_eventid",
        "suppressed",
      ],
      selectAcknowledges: "extend",
      selectTags: "extend",
      selectSuppressionData: "extend",
      sortfield: ["clock", "eventid"],
      sortorder: "ASC",
      limit: options.limit,
    };

    if (options.severities && options.severities.length > 0) {
      params.severities = options.severities.map(
        (severity) => severityToNumber[severity],
      );
    }
    return this.api.request<ZabbixEvent[]>("event.get", params);
  }

  private async fetchRecoveries(
    events: ZabbixEvent[],
  ): Promise<Map<string, ZabbixEvent>> {
    const recoveryIds = [
      ...new Set(
        events
          .map((event) => event.r_eventid)
          .filter((id): id is string => Boolean(id && id !== "0")),
      ),
    ];
    if (recoveryIds.length === 0) {
      return new Map();
    }

    const recoveries = await this.api.request<ZabbixEvent[]>("event.get", {
      eventids: recoveryIds,
      output: ["eventid", "clock", "name", "severity", "value"],
    });
    return new Map(recoveries.map((event) => [event.eventid, event]));
  }

  private async fetchHistory(
    item: ZabbixItem,
    window: ReturnType<typeof validateWindow>,
  ): Promise<{ points: NumericPoint[]; partial: boolean }> {
    const rows = await this.api.request<ZabbixHistoryValue[]>("history.get", {
      history: Number.parseInt(item.value_type, 10),
      itemids: [item.itemid],
      time_from: window.fromEpoch,
      time_till: window.toEpoch,
      output: ["itemid", "clock", "ns", "value"],
      sortfield: ["clock", "ns"],
      sortorder: "ASC",
      limit: this.policy.maxSourcePoints,
    });
    const points = rows.flatMap((row) => {
      const value = parseNumber(row.value);
      return value === null
        ? []
        : [{ clock: Number.parseInt(row.clock, 10), value }];
    });
    return {
      points,
      partial: rows.length === this.policy.maxSourcePoints,
    };
  }

  private async fetchTrends(
    item: ZabbixItem,
    window: ReturnType<typeof validateWindow>,
  ): Promise<{ points: TrendPoint[]; partial: boolean }> {
    const rows = await this.api.request<ZabbixTrendValue[]>("trend.get", {
      itemids: [item.itemid],
      time_from: window.fromEpoch,
      time_till: window.toEpoch,
      output: [
        "itemid",
        "clock",
        "num",
        "value_min",
        "value_avg",
        "value_max",
      ],
      limit: this.policy.maxSourcePoints,
    });
    const points = rows.flatMap((row) => {
      const count = parseNumber(row.num);
      const min = parseNumber(row.value_min);
      const avg = parseNumber(row.value_avg);
      const max = parseNumber(row.value_max);
      if (count === null || min === null || avg === null || max === null) {
        return [];
      }
      return [
        {
          clock: Number.parseInt(row.clock, 10),
          count,
          min,
          avg,
          max,
        },
      ];
    });
    return {
      points,
      partial: rows.length === this.policy.maxSourcePoints,
    };
  }

  private selectDataSource(
    requested: MetricDataSource,
    policyName: QueryPolicyName,
    intervalSeconds: number,
    durationSeconds: number,
    to: Date,
  ): "history" | "trends" {
    if (requested === "history") {
      if (policyName === "long_term_capacity") {
        throw new AppError(
          "HISTORY_NOT_ALLOWED",
          "Long-term policy queries must use trends",
        );
      }
      return "history";
    }

    if (requested === "trends") {
      if (intervalSeconds < 60 * 60) {
        throw new AppError(
          "AGGREGATION_TOO_FINE",
          "Zabbix trends require an aggregation of at least 1h",
        );
      }
      return "trends";
    }

    if (policyName === "long_term_capacity") {
      return "trends";
    }

    const currentHourStart = new Date(
      Math.floor(Date.now() / (60 * 60 * 1_000)) * 60 * 60 * 1_000,
    );
    const isCompleteHistoricalWindow = to <= currentHourStart;
    return intervalSeconds >= 60 * 60 &&
      durationSeconds >= 6 * 60 * 60 &&
      isCompleteHistoricalWindow
      ? "trends"
      : "history";
  }

  private metricRelevance(item: ZabbixItem, keywords: string[]): number {
    const name = item.name.toLocaleLowerCase();
    const key = item.key_.toLocaleLowerCase();
    const tags = (item.tags ?? [])
      .map((tag) => `${tag.tag} ${tag.value}`.toLocaleLowerCase())
      .join(" ");
    return keywords.reduce((score, keyword) => {
      let next = score;
      if (name.includes(keyword)) next += 5;
      if (key.includes(keyword)) next += 3;
      if (tags.includes(keyword)) next += 1;
      return next;
    }, 0);
  }

  private mapItem(item: ZabbixItem): Record<string, unknown> {
    return {
      item_id: item.itemid,
      host_id: item.hostid,
      name: item.name,
      key: item.key_,
      value_type:
        item.value_type === "0" ? "numeric_float" : "numeric_unsigned",
      unit: item.units || null,
      status: item.status === "0" ? "enabled" : "disabled",
      supported: item.state !== "1",
      delay: item.delay || null,
      tags: item.tags ?? [],
    };
  }

  private mapEvent(
    event: ZabbixEvent,
    recovery?: ZabbixEvent,
  ): Record<string, unknown> {
    return {
      evidence_id: evidenceId("event", event.eventid),
      event_id: event.eventid,
      trigger_id: event.objectid,
      name: event.name,
      severity: severityName(event.severity),
      started_at: toIso(event.clock),
      recovery_event_id: recovery?.eventid ?? null,
      recovered_at: recovery ? toIso(recovery.clock) : null,
      acknowledged: event.acknowledged === "1",
      suppressed: event.suppressed === "1",
      cause_event_id:
        event.cause_eventid && event.cause_eventid !== "0"
          ? event.cause_eventid
          : null,
      acknowledgements: (event.acknowledges ?? []).map((entry) => ({
        acknowledgement_id: entry.acknowledgeid ?? null,
        user_id: entry.userid,
        time: toIso(entry.clock),
        action: entry.action,
        message: entry.message ?? "",
      })),
      tags: event.tags ?? [],
      suppression_data: event.suppression_data ?? [],
    };
  }
}
