import { describe, expect, it } from "vitest";
import { allowedMethods, runRawQuery } from "../src/raw-query.js";
import type { QueryPolicy, ZabbixApi } from "../src/types.js";

function makePolicy(overrides: Partial<QueryPolicy> = {}): QueryPolicy {
  return {
    maxWindowHours: 26,
    longTermMaxDays: 32,
    maxEvents: 100,
    maxItemsPerCall: 20,
    maxHistoryPoints: 500,
    maxSourcePoints: 50_000,
    maxFutureHours: 2,
    minCoverageRatio: 0.95,
    allowedHostGroupIds: ["73"],
    maxRawRows: 50,
    maxRawResultChars: 12_000,
    ...overrides,
  };
}

function recorder(rows: unknown[] = [{ hostid: "1" }]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const api: ZabbixApi = {
    request: async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return rows as T;
    },
  };
  return { api, calls };
}

const allowAll = async () => undefined;

describe("query_zabbix method allowlist", () => {
  it("offers only get methods", () => {
    expect(allowedMethods().every((m) => m.endsWith(".get"))).toBe(true);
  });

  // The write methods are not reachable at all, so nothing depends on a
  // rejection branch being right.
  it("refuses anything that is not on the list", async () => {
    const { api, calls } = recorder();
    for (const method of ["host.update", "script.execute", "host.delete", "apiinfo.version"]) {
      await expect(
        runRawQuery(api, makePolicy(), { method }, allowAll, 12_000),
      ).rejects.toThrow(/not available/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("host group confinement", () => {
  // Pushed into the query rather than filtered out of the answer: the database
  // never returns a host this deployment may not see.
  it("injects the allowlist when the caller names no group", async () => {
    const { api, calls } = recorder();
    await runRawQuery(api, makePolicy(), { method: "host.get" }, allowAll, 12_000);
    expect(calls[0]!.params.groupids).toEqual(["73"]);
  });

  it("keeps a caller's narrowing and drops what it may not see", async () => {
    const { api, calls } = recorder();
    await runRawQuery(
      api,
      makePolicy({ allowedHostGroupIds: ["73", "91"] }),
      { method: "item.get", params: { groupids: ["91", "4"] } },
      allowAll,
      12_000,
    );
    expect(calls[0]!.params.groupids).toEqual(["91"]);
  });

  // An empty intersection must not widen to "everything" -- that is the shape
  // of a filter that silently stops filtering.
  it("errors rather than widening when nothing survives the intersection", async () => {
    const { api, calls } = recorder();
    await expect(
      runRawQuery(
        api,
        makePolicy(),
        { method: "host.get", params: { groupids: ["999"] } },
        allowAll,
        12_000,
      ),
    ).rejects.toThrow(/allowlist/);
    expect(calls).toHaveLength(0);
  });

  it("checks each host for a method that cannot be group filtered", async () => {
    const { api } = recorder();
    const seen: string[] = [];
    await runRawQuery(
      api,
      makePolicy(),
      { method: "hostinterface.get", params: { hostids: ["10", "11"] } },
      async (id) => {
        seen.push(id);
      },
      12_000,
    );
    expect(seen).toEqual(["10", "11"]);
  });

  it("refuses a host-scoped method with no hosts named", async () => {
    const { api } = recorder();
    await expect(
      runRawQuery(api, makePolicy(), { method: "hostinterface.get" }, allowAll, 12_000),
    ).rejects.toThrow(/hostids/);
  });
});

describe("reply bounds", () => {
  it("caps the row limit and lets a caller ask for fewer", async () => {
    const { api, calls } = recorder();
    await runRawQuery(api, makePolicy(), { method: "host.get", params: { limit: 5_000 } }, allowAll, 12_000);
    expect(calls[0]!.params.limit).toBe(50);

    await runRawQuery(api, makePolicy(), { method: "host.get", params: { limit: 3 } }, allowAll, 12_000);
    expect(calls[1]!.params.limit).toBe(3);
  });

  // One row with every field selected can outweigh a hundred narrow ones, so
  // the row count alone is not a bound on what the model has to read.
  it("cuts an oversized reply and says it did", async () => {
    const fat = Array.from({ length: 40 }, (_, i) => ({ id: String(i), blob: "x".repeat(500) }));
    const { api } = recorder(fat);
    const result = (await runRawQuery(api, makePolicy(), { method: "item.get" }, allowAll, 2_000)) as {
      returned: number;
      data_quality: { truncated_for_size: boolean };
    };

    expect(result.returned).toBeLessThan(40);
    expect(result.data_quality.truncated_for_size).toBe(true);
  });

  it("reports the query it actually sent, not the one it was given", async () => {
    const { api } = recorder();
    const result = (await runRawQuery(api, makePolicy(), { method: "host.get" }, allowAll, 12_000)) as {
      params_applied: Record<string, unknown>;
      data_quality: { confined_to_host_groups: string[] | null };
    };
    expect(result.params_applied.groupids).toEqual(["73"]);
    expect(result.data_quality.confined_to_host_groups).toEqual(["73"]);
  });

  it("says so when the deployment confines nothing", async () => {
    const { api } = recorder();
    const result = (await runRawQuery(
      api,
      makePolicy({ allowedHostGroupIds: [] }),
      { method: "host.get" },
      allowAll,
      12_000,
    )) as { data_quality: { confined_to_host_groups: string[] | null } };
    expect(result.data_quality.confined_to_host_groups).toBeNull();
  });

  it("refuses parameters that would defeat the shaping", async () => {
    const { api } = recorder();
    await expect(
      runRawQuery(api, makePolicy(), { method: "host.get", params: { countOutput: true } }, allowAll, 12_000),
    ).rejects.toThrow(/countOutput/);
  });
});
