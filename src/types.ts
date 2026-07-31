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
  allowedHostGroupIds: string[];
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
