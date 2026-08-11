import { AppError } from "./errors.js";
import type { QueryPolicy, ZabbixApi } from "./types.js";

/**
 * Read methods a caller may reach directly, and how each one can be confined
 * to the hosts this deployment is allowed to see.
 *
 * The typed tools answer the questions an investigation asks most, in the shape
 * it needs them. This is for the rest: the field that turned out to matter, the
 * entity nobody anticipated. Everything here is a `.get`, and the write methods
 * are absent rather than blocked -- a caller cannot ask for what is not on the
 * list, so there is no rejection path to get wrong.
 *
 *   `group`  - accepts groupids, so the allowlist is injected into the query
 *              and the database never returns anything outside it.
 *   `host`   - accepts hostids; each one is checked against the allowlist
 *              before the call goes out.
 *   `none`   - describes Zabbix itself rather than monitored hosts, so host
 *              grouping does not apply. Kept deliberately short.
 *
 * A method belongs here only if one of those three confinements fits it.
 * `service.get` was tried and removed: it accepts no groupids, so the injection
 * made Zabbix reject the call outright, and business services reference
 * triggers across hosts, so `none` would have offered a way around the
 * allowlist rather than a gap in it.
 */
const READ_METHODS: Record<string, "group" | "host" | "none"> = {
  "host.get": "group",
  "hostgroup.get": "group",
  "item.get": "group",
  "trigger.get": "group",
  "event.get": "group",
  "problem.get": "group",
  "graph.get": "group",
  "httptest.get": "group",
  "hostinterface.get": "host",
  "dashboard.get": "none",
  "template.get": "none",
  "usermacro.get": "none",
  // Who changed Zabbix, and when. A threshold edited an hour before the alert
  // is the kind of cause no metric shows.
  "auditlog.get": "none",
};

export interface RawQueryInput {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Narrows the offered methods to the ones this deployment's Zabbix role will
 * actually answer.
 *
 * A Zabbix role carries its own API method allowlist, and a method it refuses
 * costs a call to discover -- the tool would advertise ten methods, the model
 * would try one, and Zabbix would say "No permissions to call". Declaring the
 * subset here means the model is never offered what it cannot have.
 *
 * The map above stays the authority on how each method is confined to allowed
 * hosts, so this only ever removes. An unknown name is a configuration error
 * rather than a silent omission: it usually means a typo, and a typo that
 * quietly drops a method is how a deployment ends up with less than it thinks.
 */
export function selectMethods(requested: string[]): Record<string, "group" | "host" | "none"> {
  if (requested.length === 0) return READ_METHODS;

  const unknown = requested.filter((name) => !(name in READ_METHODS));
  if (unknown.length > 0) {
    throw new AppError(
      "CONFIG_ERROR",
      "ZABBIX_RAW_QUERY_METHODS names methods this server does not support",
      { status: 500, details: { unknown, supported: Object.keys(READ_METHODS).sort() } },
    );
  }
  return Object.fromEntries(
    requested.map((name) => [name, READ_METHODS[name]!]),
  ) as Record<string, "group" | "host" | "none">;
}

export function allowedMethods(
  methods: Record<string, "group" | "host" | "none"> = READ_METHODS,
): string[] {
  return Object.keys(methods).sort();
}

function asIdArray(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return null;
}

/**
 * A direct read against the Zabbix API, confined to the hosts this deployment
 * may see and to a reply a model can afford to read.
 */
export async function runRawQuery(
  api: ZabbixApi,
  policy: QueryPolicy,
  input: RawQueryInput,
  assertHostAllowed: (hostId: string) => Promise<unknown>,
  maxResultChars: number,
): Promise<Record<string, unknown>> {
  const methods = selectMethods(policy.rawQueryMethods);
  const method = input.method.trim();
  const scope = methods[method];
  if (!scope) {
    throw new AppError(
      "METHOD_NOT_ALLOWED",
      "That Zabbix method is not available through this tool",
      { status: 403, details: { requested: method, allowed: allowedMethods(methods) } },
    );
  }

  const params: Record<string, unknown> = { ...(input.params ?? {}) };

  // Silently dropping these would answer a different question than the one
  // asked, so they are refused instead: `countOutput` returns a bare number the
  // shaping below cannot annotate, and the two selects can expand a reply by
  // orders of magnitude with no bound this tool controls.
  for (const forbidden of ["countOutput", "selectInheritedTags", "preservekeys"]) {
    if (forbidden in params) {
      throw new AppError(
        "PARAMETER_NOT_ALLOWED",
        `${forbidden} is not supported here`,
        { status: 400, details: { parameter: forbidden } },
      );
    }
  }

  const allowlist = policy.allowedHostGroupIds;

  if (scope === "group" && allowlist.length > 0) {
    const requested = asIdArray(params.groupids);
    // Intersect rather than replace: a caller narrowing to one group keeps its
    // narrowing, and a caller asking for a group it may not see gets an empty
    // intersection, which is an error below rather than a silent widening.
    const effective = requested
      ? requested.filter((id) => allowlist.includes(id))
      : allowlist;
    if (effective.length === 0) {
      throw new AppError(
        "HOST_GROUP_NOT_ALLOWED",
        "None of the requested host groups are within the configured allowlist",
        { status: 403, details: { requested: requested ?? [], allowed: allowlist } },
      );
    }
    params.groupids = effective;
  }

  if (scope === "host") {
    const hostIds = asIdArray(params.hostids);
    if (!hostIds || hostIds.length === 0) {
      throw new AppError(
        "HOST_REQUIRED",
        `${method} requires hostids so the result can be confined to allowed hosts`,
        { status: 400 },
      );
    }
    await Promise.all(hostIds.map((id) => assertHostAllowed(id)));
  }

  // A bound the caller may lower but not raise. Without it `item.get` on a
  // busy group returns thousands of rows that arrive as tokens.
  const requestedLimit = Number(params.limit);
  params.limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, policy.maxRawRows)
    : policy.maxRawRows;

  const raw = await api.request<unknown>(method, params);
  const rows = Array.isArray(raw) ? raw : [raw];

  // Truncated by characters as well as by rows: one row of an item with every
  // field selected can be larger than a hundred rows of two fields.
  let text = JSON.stringify(rows);
  let returned = rows.length;
  let truncated = false;
  while (text.length > maxResultChars && returned > 1) {
    returned = Math.floor(returned / 2);
    text = JSON.stringify(rows.slice(0, returned));
    truncated = true;
  }

  return {
    method,
    // What was actually sent, including the group filter this tool inserted --
    // a caller comparing counts needs to know its query was narrowed.
    params_applied: params,
    returned,
    rows: rows.slice(0, returned),
    data_quality: {
      row_limit: policy.maxRawRows,
      hit_row_limit: rows.length >= policy.maxRawRows,
      // True when the reply had to be cut to fit, which means the answer is a
      // prefix of the result rather than the result.
      truncated_for_size: truncated,
      // Absent when this deployment sets no allowlist, so a caller can tell
      // "everything" from "everything I am allowed to see".
      confined_to_host_groups: allowlist.length > 0 ? allowlist : null,
    },
  };
}
