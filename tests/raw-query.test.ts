import { describe, expect, it } from "vitest";
import { allowedMethods, runRawQuery, selectMethods } from "../src/raw-query.js";
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
    rawQueryMethods: [],
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

describe("matching what the Zabbix role permits", () => {
  // A Zabbix role carries its own API allowlist. Offering a method it refuses
  // costs a call to find out, so a deployment declares the subset it has.
  it("offers only the declared subset", async () => {
    const policy = makePolicy({ rawQueryMethods: ["host.get", "item.get"] });
    expect(allowedMethods(selectMethods(policy.rawQueryMethods))).toEqual([
      "host.get",
      "item.get",
    ]);

    const { api, calls } = recorder();
    await expect(
      runRawQuery(api, policy, { method: "auditlog.get" }, allowAll, 12_000),
    ).rejects.toThrow(/not available/);
    expect(calls).toHaveLength(0);

    await runRawQuery(api, policy, { method: "host.get" }, allowAll, 12_000);
    expect(calls).toHaveLength(1);
  });

  it("offers everything it knows when nothing is declared", () => {
    expect(allowedMethods(selectMethods([])).length).toBeGreaterThan(2);
  });

  // A typo that quietly drops a method leaves a deployment with less than it
  // believes it configured, and nothing to read that says so.
  it("refuses to start on a name it does not know", () => {
    expect(() => selectMethods(["host.get", "hosts.get"])).toThrow(/does not support/);
  });
});

describe("only methods this server can actually confine", () => {
  // Every group-scoped method has to accept groupids, or the injection turns a
  // working query into "Invalid params". service.get looked group-shaped, took
  // no groupids, and failed against the real API for exactly that reason.
  it("scopes by group only where groupids is a real parameter", () => {
    const known = allowedMethods(selectMethods([]));
    expect(known).not.toContain("service.get");
    expect(known).toContain("host.get");
  });
});

describe("templates you cannot see", () => {
  /**
   * Zabbix 6.0 moved templates into their own groups with their own
   * permissions. A role granted read on a host group still sees an empty
   * parentTemplates for a host that has templates linked, and an investigation
   * reported that as "0 templates" -- while two of the host's triggers carried
   * a templateid, which only happens when a template is linked.
   */
  const policy: QueryPolicy = {
    maxWindowHours: 26,
    longTermMaxDays: 400,
    maxEvents: 100,
    maxItemsPerCall: 20,
    maxHistoryPoints: 1_000,
    maxSourcePoints: 50_000,
    maxFutureHours: 2,
    minCoverageRatio: 0.95,
    allowedHostGroupIds: [],
    maxRawRows: 50,
    maxRawResultChars: 12_000,
    rawQueryMethods: ["host.get", "template.get"],
  };

  function api(handlers: Record<string, (p: Record<string, unknown>) => unknown>) {
    const calls: string[] = [];
    return {
      calls,
      async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        calls.push(method);
        const handler = handlers[method];
        if (!handler) {
          throw new Error(`unexpected Zabbix method: ${method}`);
        }
        return handler(params) as T;
      },
    };
  }

  const allow = async () => undefined;

  it("says templates are invisible when the account can see none", async () => {
    const client = api({
      "host.get": () => [{ hostid: "11094", parentTemplates: [] }],
      "template.get": () => [],
    });
    const result = await runRawQuery(
      client,
      policy,
      { method: "host.get", params: { hostids: ["11094"], selectParentTemplates: ["name"] } },
      allow,
      12_000,
    );
    const quality = result.data_quality as Record<string, unknown>;
    expect(quality.templates_visible).toBe(false);
    expect(client.calls).toContain("template.get");
  });

  it("says nothing when the account can see templates", async () => {
    // Then an empty list really is an empty list, and an annotation would only
    // cast doubt on a true answer.
    const client = api({
      "host.get": () => [{ hostid: "11094", parentTemplates: [] }],
      "template.get": () => [{ templateid: "10001" }],
    });
    const result = await runRawQuery(
      client,
      policy,
      { method: "host.get", params: { hostids: ["11094"], selectParentTemplates: ["name"] } },
      allow,
      12_000,
    );
    expect((result.data_quality as Record<string, unknown>).templates_visible).toBe(true);
  });

  it("does not probe when templates were found", async () => {
    const client = api({
      "host.get": () => [{ hostid: "11094", parentTemplates: [{ name: "Docker" }] }],
    });
    const result = await runRawQuery(
      client,
      policy,
      { method: "host.get", params: { hostids: ["11094"], selectParentTemplates: ["name"] } },
      allow,
      12_000,
    );
    expect(client.calls).toEqual(["host.get"]);
    expect((result.data_quality as Record<string, unknown>).templates_visible).toBeUndefined();
  });

  it("does not probe for a question that is not about templates", async () => {
    const client = api({ "host.get": () => [{ hostid: "11094" }] });
    await runRawQuery(client, policy, { method: "host.get", params: { hostids: ["11094"] } }, allow, 12_000);
    expect(client.calls).toEqual(["host.get"]);
  });
});

describe("macros belong to hosts", () => {
  /**
   * usermacro.get was unscoped, so it reached every host the Zabbix role could
   * see and global macros besides. Global macros are the ones most likely to
   * hold a credential and are never the answer to a question about one host.
   */
  const policy: QueryPolicy = {
    maxWindowHours: 26,
    longTermMaxDays: 400,
    maxEvents: 100,
    maxItemsPerCall: 20,
    maxHistoryPoints: 1_000,
    maxSourcePoints: 50_000,
    maxFutureHours: 2,
    minCoverageRatio: 0.95,
    allowedHostGroupIds: ["73"],
    maxRawRows: 50,
    maxRawResultChars: 12_000,
    rawQueryMethods: ["usermacro.get"],
  };
  const api = {
    async request<T>(): Promise<T> {
      return [] as unknown as T;
    },
  };

  it("refuses a macro query that names no host", async () => {
    await expect(
      runRawQuery(api, policy, { method: "usermacro.get", params: {} }, async () => undefined, 12_000),
    ).rejects.toThrowError(/hostids/);
  });

  it("refuses a global macro query", async () => {
    // globalmacro: true names no host by definition, so it cannot be confined.
    await expect(
      runRawQuery(
        api,
        policy,
        { method: "usermacro.get", params: { globalmacro: true } },
        async () => undefined,
        12_000,
      ),
    ).rejects.toThrowError(/hostids/);
  });

  it("checks each named host against the allowlist", async () => {
    const checked: string[] = [];
    await runRawQuery(
      api,
      policy,
      { method: "usermacro.get", params: { hostids: ["11094", "10663"] } },
      async (hostId) => {
        checked.push(hostId);
      },
      12_000,
    );
    expect(checked).toEqual(["11094", "10663"]);
  });
});

// runRawQuery is typed as a bare record, so the tests below name the one field
// they read rather than asserting on `unknown`.
function quality(result: Record<string, unknown>): Record<string, unknown> {
  return result.data_quality as Record<string, unknown>;
}

describe("selects Zabbix accepted without answering", () => {
  // The case that started this: `selectTemplates` on host.get came back with no
  // template field and the report read it as zero templates. That spelling is
  // corrected outright now, so the example here is one with no single correct
  // target -- selectHosts belongs to trigger.get and item.get, and what a
  // caller naming it on host.get wanted is theirs to say, not this tool's.
  it("names a select that produced no field", async () => {
    const { api } = recorder([{ hostid: "11094", name: "vm-java-docker-2" }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"], selectHosts: ["name"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toEqual(["selectHosts"]);
  });

  it("stays quiet when the select was answered", async () => {
    const { api } = recorder([
      { hostid: "11094", parentTemplates: [{ templateid: "11083", name: "Docker" }] },
    ]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      {
        method: "host.get",
        params: { hostids: ["11094"], selectParentTemplates: ["name"] },
      },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toBeUndefined();
  });

  it("treats an answered-but-empty field as answered", async () => {
    // A host with no triggers is a fact. Reporting it as an ignored parameter
    // would replace one wrong reading with another.
    const { api } = recorder([{ hostid: "11094", triggers: [] }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"], selectTriggers: ["triggerid"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toBeUndefined();
  });

  it("reports each ignored select separately", async () => {
    const { api } = recorder([{ hostid: "11094", triggers: [] }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      {
        method: "host.get",
        params: {
          hostids: ["11094"],
          selectTriggers: ["triggerid"],
          selectHosts: ["name"],
          selectHostGroups: ["name"],
        },
      },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toEqual([
      "selectHosts",
      "selectHostGroups",
    ]);
  });

  it("says nothing when there were no rows to judge by", async () => {
    // An empty result set is evidence about the filter, not about the select.
    const { api } = recorder([]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["404"], selectHosts: ["name"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toBeUndefined();
  });
});

describe("selects this method spells differently", () => {
  // Told its parameter had been ignored, the next run reported that it could
  // not determine the templates -- true, and still not the answer. Knowing a
  // name is wrong does not supply the right one, and there is only one right
  // one here: a host has no child templates, so selectTemplates on host.get can
  // mean nothing but selectParentTemplates.
  it("sends the name Zabbix answers", async () => {
    const { api, calls } = recorder([
      { hostid: "11094", parentTemplates: [{ templateid: "11083", name: "Docker" }] },
    ]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"], selectTemplates: ["name"] } },
      allowAll,
      12_000,
    );
    expect(calls[0]!.params.selectParentTemplates).toEqual(["name"]);
    expect(calls[0]!.params.selectTemplates).toBeUndefined();
    expect(quality(result).selects_renamed).toEqual([
      { from: "selectTemplates", to: "selectParentTemplates" },
    ]);
  });

  it("does not leave the caller reading an ignored parameter as well", async () => {
    // The two annotations would otherwise contradict each other: renamed and
    // answered, yet reported as ignored because the original name filled nothing.
    const { api } = recorder([
      { hostid: "11094", parentTemplates: [{ templateid: "11083", name: "Docker" }] },
    ]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"], selectTemplates: ["name"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).selects_ignored).toBeUndefined();
  });

  it("leaves the correct spelling alone", async () => {
    const { api, calls } = recorder([{ hostid: "11094", parentTemplates: [] }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      {
        method: "host.get",
        params: { hostids: ["11094"], selectParentTemplates: ["name"] },
      },
      allowAll,
      12_000,
    );
    expect(calls[0]!.params.selectParentTemplates).toEqual(["name"]);
    expect(quality(result).selects_renamed).toBeUndefined();
  });

  it("keeps what the caller already spelled right when both are named", async () => {
    const { api, calls } = recorder([{ hostid: "11094", parentTemplates: [] }]);
    await runRawQuery(
      api,
      makePolicy(),
      {
        method: "host.get",
        params: {
          hostids: ["11094"],
          selectTemplates: ["templateid"],
          selectParentTemplates: ["name"],
        },
      },
      allowAll,
      12_000,
    );
    expect(calls[0]!.params.selectParentTemplates).toEqual(["name"]);
    expect(calls[0]!.params.selectTemplates).toBeUndefined();
  });

  it("corrects nothing on a method that has no alias", async () => {
    // template.get is where selectTemplates means something of its own, and
    // rewriting it there would answer a different question than the one asked.
    const { api, calls } = recorder([{ templateid: "11083", templates: [] }]);
    const result = await runRawQuery(
      api,
      makePolicy({ rawQueryMethods: ["template.get"] }),
      { method: "template.get", params: { selectTemplates: ["name"] } },
      allowAll,
      12_000,
    );
    expect(calls[0]!.params.selectTemplates).toEqual(["name"]);
    expect(quality(result).selects_renamed).toBeUndefined();
  });
});

describe("counting what a select returned", () => {
  // Handed a host with twenty-six triggers, a report stated twenty-five.
  // Zabbix returned twenty-six, the reply was not truncated, and the evidence
  // held all of them -- the count was recomputed by eye at the far end. The
  // length is known here, so it is stated here.
  it("states the length of each nested array", async () => {
    const { api } = recorder([
      {
        hostid: "11094",
        parentTemplates: [{ templateid: "11083" }, { templateid: "11084" }],
        triggers: Array.from({ length: 26 }, (_, i) => ({ triggerid: String(i) })),
      },
    ]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      {
        method: "host.get",
        params: {
          hostids: ["11094"],
          selectParentTemplates: ["templateid"],
          selectTriggers: ["triggerid"],
        },
      },
      allowAll,
      12_000,
    );
    expect(quality(result).select_counts).toEqual({
      parentTemplates: 2,
      triggers: 26,
    });
  });

  it("counts an empty select as zero rather than omitting it", async () => {
    // Zero is the answer to "how many", and leaving it out would send the
    // reader back to counting an absence.
    const { api } = recorder([{ hostid: "11094", triggers: [] }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"], selectTriggers: ["triggerid"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).select_counts).toEqual({ triggers: 0 });
  });

  it("says nothing when several rows make the count ambiguous", async () => {
    // Across hosts "how many triggers" has an answer per row, and one summed
    // number would be a worse answer than none.
    const { api } = recorder([
      { hostid: "1", triggers: [{ triggerid: "a" }] },
      { hostid: "2", triggers: [{ triggerid: "b" }, { triggerid: "c" }] },
    ]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { selectTriggers: ["triggerid"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).select_counts).toBeUndefined();
  });

  it("says nothing when the row carries no arrays", async () => {
    const { api } = recorder([{ hostid: "11094", name: "vm-java-docker-2" }]);
    const result = await runRawQuery(
      api,
      makePolicy(),
      { method: "host.get", params: { hostids: ["11094"] } },
      allowAll,
      12_000,
    );
    expect(quality(result).select_counts).toBeUndefined();
  });
})
