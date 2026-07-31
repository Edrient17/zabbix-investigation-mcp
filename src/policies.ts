import { AppError } from "./errors.js";
import type {
  Aggregation,
  QueryPolicy,
  QueryPolicyName,
  TimeWindow,
} from "./types.js";

const isoWithTimezone =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const aggregationSeconds: Record<Aggregation, number | null> = {
  raw: null,
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "1d": 24 * 60 * 60,
};

export interface ValidatedWindow {
  from: Date;
  to: Date;
  fromEpoch: number;
  toEpoch: number;
  durationSeconds: number;
}

export function parseIsoTime(value: string, field: string): Date {
  if (!isoWithTimezone.test(value)) {
    throw new AppError(
      "INVALID_TIME",
      `${field} must be an ISO 8601 timestamp with a timezone`,
      { details: { field } },
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new AppError("INVALID_TIME", `${field} is not a valid timestamp`, {
      details: { field },
    });
  }
  return parsed;
}

export function validateWindow(
  window: TimeWindow,
  policyName: QueryPolicyName,
  policy: QueryPolicy,
  aggregation: Aggregation,
  now = new Date(),
): ValidatedWindow {
  const from = parseIsoTime(window.from, "time_from");
  const to = parseIsoTime(window.to, "time_to");
  const durationSeconds = (to.valueOf() - from.valueOf()) / 1_000;

  if (durationSeconds <= 0) {
    throw new AppError(
      "INVALID_TIME_RANGE",
      "time_to must be later than time_from",
    );
  }

  const maximumSeconds =
    policyName === "long_term_capacity"
      ? policy.longTermMaxDays * 24 * 60 * 60
      : policy.maxWindowHours * 60 * 60;

  if (durationSeconds > maximumSeconds) {
    throw new AppError(
      "TIME_RANGE_LIMIT_EXCEEDED",
      `Requested time range exceeds the ${policyName} policy`,
      {
        details: {
          requested_seconds: durationSeconds,
          maximum_seconds: maximumSeconds,
        },
      },
    );
  }

  if (
    policyName === "long_term_capacity" &&
    (aggregationSeconds[aggregation] ?? 0) < 60 * 60
  ) {
    throw new AppError(
      "AGGREGATION_TOO_FINE",
      "Long-term queries require an aggregation of at least 1h",
    );
  }

  const maximumFuture = now.valueOf() + policy.maxFutureHours * 60 * 60 * 1_000;
  if (to.valueOf() > maximumFuture) {
    throw new AppError(
      "FUTURE_TIME_LIMIT_EXCEEDED",
      "time_to is too far in the future",
      {
        details: {
          max_future_hours: policy.maxFutureHours,
        },
      },
    );
  }

  return {
    from,
    to,
    fromEpoch: Math.floor(from.valueOf() / 1_000),
    toEpoch: Math.floor(to.valueOf() / 1_000),
    durationSeconds,
  };
}

export function getAggregationSeconds(
  aggregation: Aggregation,
): number | null {
  return aggregationSeconds[aggregation];
}

export function clampLimit(
  requested: number | undefined,
  maximum: number,
  fallback: number,
): number {
  return Math.min(requested ?? fallback, maximum);
}
