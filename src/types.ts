export interface ZabbixApi {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export interface QueryPolicy {
  maxWindowHours: number;
  longTermMaxDays: number;
  maxEvents: number;
  maxItemsPerCall: number;
  maxHistoryPoints: number;
  maxSourcePoints: number;
  maxFutureHours: number;
  /**
   * Coverage below this ratio marks a result partial. A window the source data
   * only sparsely covers is not a complete answer, even when nothing was
   * truncated by a query limit.
   */
  minCoverageRatio: number;
  allowedHostGroupIds: string[];
  /** Rows a single direct read may return before it is cut short. */
  maxRawRows: number;
  /** Characters a direct read may return, whatever the row count. */
  maxRawResultChars: number;
  /**
   * Which methods the direct read offers. Empty means every method this server
   * knows how to confine; a shorter list matches a Zabbix role that permits
   * fewer, so the model is never offered one that would be refused.
   */
  rawQueryMethods: string[];
}

export type QueryPolicyName = "standard" | "long_term_capacity";

export const aggregationValues = [
  "raw",
  "1m",
  "5m",
  "15m",
  "1h",
  "6h",
  "1d",
] as const;

export type Aggregation = (typeof aggregationValues)[number];

export type MetricDataSource = "auto" | "history" | "trends";

export interface TimeWindow {
  from: string;
  to: string;
}

export interface NumericPoint {
  clock: number;
  value: number;
}

export interface TrendPoint {
  clock: number;
  count: number;
  min: number;
  max: number;
  avg: number;
}

export interface AggregatedPoint {
  time: string;
  min: number;
  max: number;
  avg: number;
  first: number;
  last: number;
  count: number;
}

export interface SeriesSummary {
  min: number | null;
  max: number | null;
  avg: number | null;
  first: number | null;
  last: number | null;
  change_percent: number | null;
  trend: "increasing" | "decreasing" | "stable" | "insufficient_data";
}

export interface DataQuality {
  data_source: "history" | "trends";
  sample_count: number;
  returned_points: number;
  expected_buckets: number | null;
  coverage_ratio: number | null;
  partial: boolean;
}

export interface AppConfig {
  zabbix: {
    url: string;
    apiToken: string;
    timeoutMs: number;
  };
  mcp: {
    host: string;
    port: number;
    path: string;
    authToken: string | null;
    allowedHosts: string[];
  };
  policy: QueryPolicy;
  defaultTimezone: string;
  logLevel: "debug" | "info" | "warn" | "error";
}
