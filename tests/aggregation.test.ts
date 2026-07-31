import { describe, expect, it } from "vitest";
import {
  aggregateHistory,
  aggregateTrends,
  coverageRatio,
  summarizeSeries,
} from "../src/aggregation.js";

describe("history aggregation", () => {
  it("aggregates raw values into deterministic five-minute buckets", () => {
    const from = Date.parse("2026-07-30T01:00:00Z") / 1_000;
    const points = Array.from({ length: 10 }, (_, index) => ({
      clock: from + index * 60,
      value: index + 1,
    }));

    const result = aggregateHistory(points, from, from + 10 * 60, 5 * 60);

    expect(result).toEqual([
      {
        time: "2026-07-30T01:00:00.000Z",
        min: 1,
        max: 5,
        avg: 3,
        first: 1,
        last: 5,
        count: 5,
      },
      {
        time: "2026-07-30T01:05:00.000Z",
        min: 6,
        max: 10,
        avg: 8,
        first: 6,
        last: 10,
        count: 5,
      },
    ]);
    expect(summarizeSeries(result)).toMatchObject({
      min: 1,
      max: 10,
      avg: 5.5,
      first: 1,
      last: 10,
      change_percent: 900,
      trend: "increasing",
    });
  });

  it("returns raw points without inventing missing values", () => {
    const from = Date.parse("2026-07-30T01:00:00Z") / 1_000;
    const result = aggregateHistory(
      [
        { clock: from, value: 3 },
        { clock: from + 120, value: 7 },
      ],
      from,
      from + 300,
      null,
    );

    expect(result).toHaveLength(2);
    expect(coverageRatio(result.length, 5)).toBe(0.4);
  });
});

describe("trend aggregation", () => {
  it("uses the trend sample count for weighted averages", () => {
    const from = Date.parse("2026-07-01T00:00:00Z") / 1_000;
    const result = aggregateTrends(
      [
        { clock: from, count: 10, min: 0, max: 20, avg: 10 },
        { clock: from + 3600, count: 30, min: 10, max: 40, avg: 30 },
      ],
      from,
      from + 7200,
      7200,
    );

    expect(result).toEqual([
      {
        time: "2026-07-01T00:00:00.000Z",
        min: 0,
        max: 40,
        avg: 25,
        first: 10,
        last: 30,
        count: 40,
      },
    ]);
  });
});
