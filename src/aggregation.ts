import type {
  AggregatedPoint,
  NumericPoint,
  SeriesSummary,
  TrendPoint,
} from "./types.js";

interface BucketAccumulator {
  start: number;
  min: number;
  max: number;
  weightedSum: number;
  count: number;
  first: number;
  last: number;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function toPoint(bucket: BucketAccumulator): AggregatedPoint {
  return {
    time: new Date(bucket.start * 1_000).toISOString(),
    min: round(bucket.min),
    max: round(bucket.max),
    avg: round(bucket.weightedSum / bucket.count),
    first: round(bucket.first),
    last: round(bucket.last),
    count: bucket.count,
  };
}

export function aggregateHistory(
  input: NumericPoint[],
  fromEpoch: number,
  toEpoch: number,
  intervalSeconds: number | null,
): AggregatedPoint[] {
  const points = [...input]
    .filter(
      (point) =>
        Number.isFinite(point.value) &&
        point.clock >= fromEpoch &&
        point.clock <= toEpoch,
    )
    .sort((left, right) => left.clock - right.clock);

  if (intervalSeconds === null) {
    return points.map((point) => ({
      time: new Date(point.clock * 1_000).toISOString(),
      min: round(point.value),
      max: round(point.value),
      avg: round(point.value),
      first: round(point.value),
      last: round(point.value),
      count: 1,
    }));
  }

  const buckets = new Map<number, BucketAccumulator>();
  for (const point of points) {
    const index = Math.floor((point.clock - fromEpoch) / intervalSeconds);
    const start = fromEpoch + index * intervalSeconds;
    const existing = buckets.get(index);

    if (!existing) {
      buckets.set(index, {
        start,
        min: point.value,
        max: point.value,
        weightedSum: point.value,
        count: 1,
        first: point.value,
        last: point.value,
      });
      continue;
    }

    existing.min = Math.min(existing.min, point.value);
    existing.max = Math.max(existing.max, point.value);
    existing.weightedSum += point.value;
    existing.count += 1;
    existing.last = point.value;
  }

  return [...buckets.values()]
    .sort((left, right) => left.start - right.start)
    .map(toPoint);
}

export function aggregateTrends(
  input: TrendPoint[],
  fromEpoch: number,
  toEpoch: number,
  intervalSeconds: number,
): AggregatedPoint[] {
  const points = [...input]
    .filter(
      (point) =>
        point.count > 0 &&
        point.clock >= fromEpoch &&
        point.clock <= toEpoch,
    )
    .sort((left, right) => left.clock - right.clock);
  const buckets = new Map<number, BucketAccumulator>();

  for (const point of points) {
    const index = Math.floor((point.clock - fromEpoch) / intervalSeconds);
    const start = fromEpoch + index * intervalSeconds;
    const existing = buckets.get(index);

    if (!existing) {
      buckets.set(index, {
        start,
        min: point.min,
        max: point.max,
        weightedSum: point.avg * point.count,
        count: point.count,
        first: point.avg,
        last: point.avg,
      });
      continue;
    }

    existing.min = Math.min(existing.min, point.min);
    existing.max = Math.max(existing.max, point.max);
    existing.weightedSum += point.avg * point.count;
    existing.count += point.count;
    existing.last = point.avg;
  }

  return [...buckets.values()]
    .sort((left, right) => left.start - right.start)
    .map(toPoint);
}

export function summarizeSeries(points: AggregatedPoint[]): SeriesSummary {
  if (points.length === 0) {
    return {
      min: null,
      max: null,
      avg: null,
      first: null,
      last: null,
      change_percent: null,
      trend: "insufficient_data",
    };
  }

  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  if (!firstPoint || !lastPoint) {
    throw new Error("Series bounds unexpectedly missing");
  }

  const totalCount = points.reduce((sum, point) => sum + point.count, 0);
  const average =
    points.reduce((sum, point) => sum + point.avg * point.count, 0) /
    totalCount;
  const first = firstPoint.first;
  const last = lastPoint.last;
  const changePercent =
    first === 0 ? null : round(((last - first) / Math.abs(first)) * 100);

  let trend: SeriesSummary["trend"] = "insufficient_data";
  if (points.length >= 2) {
    if (changePercent === null) {
      trend = last === first ? "stable" : last > first ? "increasing" : "decreasing";
    } else if (Math.abs(changePercent) < 5) {
      trend = "stable";
    } else {
      trend = changePercent > 0 ? "increasing" : "decreasing";
    }
  }

  return {
    min: round(Math.min(...points.map((point) => point.min))),
    max: round(Math.max(...points.map((point) => point.max))),
    avg: round(average),
    first: round(first),
    last: round(last),
    change_percent: changePercent,
    trend,
  };
}

export function expectedBucketCount(
  fromEpoch: number,
  toEpoch: number,
  intervalSeconds: number | null,
): number | null {
  if (intervalSeconds === null) {
    return null;
  }
  return Math.max(1, Math.ceil((toEpoch - fromEpoch) / intervalSeconds));
}

export function coverageRatio(
  returnedPoints: number,
  expectedBuckets: number | null,
): number | null {
  if (expectedBuckets === null) {
    return null;
  }
  return round(Math.min(1, returnedPoints / expectedBuckets));
}
