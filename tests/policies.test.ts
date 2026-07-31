import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { validateWindow } from "../src/policies.js";
import type { QueryPolicy } from "../src/types.js";

const policy: QueryPolicy = {
  maxWindowHours: 26,
  longTermMaxDays: 30,
  maxEvents: 100,
  maxItemsPerCall: 20,
  maxHistoryPoints: 1_000,
  maxSourcePoints: 50_000,
  maxFutureHours: 2,
  allowedHostGroupIds: [],
};

const now = new Date("2026-07-30T12:00:00Z");

describe("query policies", () => {
  it("accepts a standard incident window", () => {
    const result = validateWindow(
      {
        from: "2026-07-30T09:00:00+09:00",
        to: "2026-07-30T10:00:00+09:00",
      },
      "standard",
      policy,
      "1m",
      now,
    );
    expect(result.durationSeconds).toBe(3600);
  });

  it("rejects timestamps without an explicit timezone", () => {
    expect(() =>
      validateWindow(
        {
          from: "2026-07-30T09:00:00",
          to: "2026-07-30T10:00:00",
        },
        "standard",
        policy,
        "1m",
        now,
      ),
    ).toThrowError(AppError);
  });

  it("requires at least hourly aggregation for long-term queries", () => {
    expect(() =>
      validateWindow(
        {
          from: "2026-07-01T00:00:00Z",
          to: "2026-07-20T00:00:00Z",
        },
        "long_term_capacity",
        policy,
        "15m",
        now,
      ),
    ).toThrowError(/at least 1h/);
  });

  it("rejects a standard window longer than the configured limit", () => {
    expect(() =>
      validateWindow(
        {
          from: "2026-07-20T00:00:00Z",
          to: "2026-07-22T00:00:00Z",
        },
        "standard",
        policy,
        "1h",
        now,
      ),
    ).toThrowError(/exceeds/);
  });
});
