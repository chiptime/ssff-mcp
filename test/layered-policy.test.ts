import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLayeredPolicy,
  type LayeredPolicyQuery,
  type PolicyLayer,
} from "../src/layered-policy.js";
import {
  isEntityPermitted,
  permittedFieldsFor,
  type AllowlistEntry,
} from "../src/allowlist.js";

/**
 * Layered policy composition (Phase 3, FR-07/FR-08): an ENVIRONMENT policy and
 * a ROLE policy are combined over one entity/protocol/schema-keys query.
 *
 * - Both layers must permit the entity; a denylist in either layer wins.
 * - Absent or empty lists/fields never narrow their OWN layer, and never
 *   remove the other layer's narrowing.
 * - Field restrictions are an explicit discriminated unrestricted/restricted
 *   Set: a disjoint intersection is RESTRICTED (keys only), never "open".
 * - Schema keys are always readable for a permitted entity, but keys never
 *   rescue a denied entity.
 * - Restricted fields with an unresolved schema fail closed, mirroring
 *   `allowedProperties`.
 */

/** Valid baseline query; every validation test spreads an invalid override in. */
const base: LayeredPolicyQuery = {
  entity: "User",
  schemaKeys: ["userId"],
  environment: {},
  role: {},
};

const allow = (entity: string, fields?: string[]): AllowlistEntry[] =>
  fields === undefined ? [{ entity }] : [{ entity, fields }];

function decision(overrides: Partial<LayeredPolicyQuery> = {}) {
  return evaluateLayeredPolicy({ ...base, ...overrides });
}

test("layered policy: both layers unrestricted permits any entity", () => {
  const result = decision();
  assert.equal(result.permitted, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.entity, "User");
  assert.equal(result.protocol, "v2"); // default protocol, like the helpers
  assert.deepEqual(result.fields, { kind: "unrestricted" });
});

test("layered policy: entity must be permitted by BOTH environment and role layers", () => {
  // Environment allows User, role allowlist does not: denied by the role.
  const roleNarrows = decision({
    environment: {},
    role: { entityAllowlist: allow("EmpJob") },
  });
  assert.equal(roleNarrows.permitted, false);
  assert.deepEqual(roleNarrows.reason, { source: "role", cause: "allowlist" });

  // Role allows User, environment allowlist does not: denied by the environment.
  const environmentNarrows = decision({
    environment: { entityAllowlist: allow("EmpJob") },
    role: {},
  });
  assert.equal(environmentNarrows.permitted, false);
  assert.deepEqual(environmentNarrows.reason, { source: "environment", cause: "allowlist" });

  // Both allow it: permitted.
  const bothAllow = decision({
    environment: { entityAllowlist: allow("User") },
    role: { entityAllowlist: allow("User") },
  });
  assert.equal(bothAllow.permitted, true);
  assert.equal(bothAllow.reason, undefined);
});

test("layered policy: a denylist in EITHER layer wins over both allowlists", () => {
  const environmentDenies = decision({
    environment: { entityDenylist: allow("User") },
    role: { entityAllowlist: allow("User") },
  });
  assert.equal(environmentDenies.permitted, false);
  assert.deepEqual(environmentDenies.reason, { source: "environment", cause: "denylist" });

  const roleDenies = decision({
    environment: { entityAllowlist: allow("User") },
    role: { entityDenylist: allow("User") },
  });
  assert.equal(roleDenies.permitted, false);
  assert.deepEqual(roleDenies.reason, { source: "role", cause: "denylist" });
});

test("layered policy: when both layers deny, the environment (ceiling) reason is reported", () => {
  const result = decision({
    environment: { entityAllowlist: allow("User"), entityDenylist: allow("User") },
    role: { entityAllowlist: allow("User"), entityDenylist: allow("User") },
  });
  assert.equal(result.permitted, false);
  assert.deepEqual(result.reason, { source: "environment", cause: "denylist" });
});

test("layered policy: absent or empty allowlists narrow only their own layer", () => {
  // Empty environment allowlist is NOT deny-all: the role layer still decides.
  const emptyEnvironment = decision({
    environment: { entityAllowlist: [] },
    role: { entityAllowlist: allow("User") },
  });
  assert.equal(emptyEnvironment.permitted, true);

  // Symmetrically for the role layer.
  const emptyRole = decision({
    environment: { entityAllowlist: allow("User") },
    role: { entityAllowlist: [] },
  });
  assert.equal(emptyRole.permitted, true);
});

test("layered policy: absent or empty fields narrow only their own layer", () => {
  // Environment entry with fields: [] does not narrow; the role restriction applies.
  const emptyEnvironmentFields = decision({
    environment: { entityAllowlist: [{ entity: "User", fields: [] }] },
    role: { entityAllowlist: allow("User", ["firstName"]) },
  });
  assert.equal(emptyEnvironmentFields.permitted, true);
  assert.deepEqual(emptyEnvironmentFields.fields, {
    kind: "restricted",
    fields: new Set(["firstName", "userId"]),
  });

  // Symmetrically: the role layer leaves fields open, only the environment narrows.
  const onlyEnvironmentNarrows = decision({
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: { entityAllowlist: allow("User") },
  });
  assert.deepEqual(onlyEnvironmentNarrows.fields, {
    kind: "restricted",
    fields: new Set(["firstName", "userId"]),
  });
});

test("layered policy: both layers restricting intersects their field sets", () => {
  const result = decision({
    environment: { entityAllowlist: allow("User", ["firstName", "salary"]) },
    role: { entityAllowlist: allow("User", ["salary", "email"]) },
  });
  assert.equal(result.permitted, true);
  assert.deepEqual(result.fields, {
    kind: "restricted",
    fields: new Set(["salary", "userId"]), // intersection + always-readable keys
  });
});

test("layered policy: disjoint restrictions stay RESTRICTED to keys only, never unrestricted", () => {
  const result = decision({
    environment: { entityAllowlist: allow("User", ["firstName", "salary"]) },
    role: { entityAllowlist: allow("User", ["email"]) },
  });
  assert.equal(result.permitted, true);
  // The intersection is empty: readable set is exactly the schema keys.
  assert.deepEqual(result.fields, {
    kind: "restricted",
    fields: new Set(["userId"]),
  });
  // The empty intersection must NOT collapse into "unrestricted".
  assert.notEqual(result.fields.kind, "unrestricted");
});

test("layered policy: disjoint restrictions with KNOWN zero keys stay restricted and empty", () => {
  // schemaKeys: [] is a resolved schema with no keys — different from undefined.
  const result = decision({
    schemaKeys: [],
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: { entityAllowlist: allow("User", ["email"]) },
  });
  assert.equal(result.permitted, true);
  assert.deepEqual(result.fields, { kind: "restricted", fields: new Set() });
  assert.notEqual(result.fields.kind, "unrestricted");
});

test("layered policy: schema keys are always readable but never rescue a denied entity", () => {
  // Permitted entity: the key is readable even though no layer lists it.
  const permitted = decision({
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: { entityAllowlist: allow("User", ["firstName"]) },
  });
  assert.deepEqual(permitted.fields, {
    kind: "restricted",
    fields: new Set(["firstName", "userId"]),
  });

  // Denied entity: keys do not make the entity (or anything on it) readable.
  const denied = decision({
    environment: { entityDenylist: allow("User") },
    role: { entityAllowlist: allow("User") },
  });
  assert.equal(denied.permitted, false);
  assert.deepEqual(denied.fields, { kind: "restricted", fields: new Set() });
});

test("layered policy: protocol matching keeps the existing helper semantics", () => {
  const layers: { environment: PolicyLayer; role: PolicyLayer } = {
    environment: { entityAllowlist: [{ entity: "User", protocols: ["v4"] }] },
    role: {},
  };

  // Default protocol is v2: a v4-only allowlist entry never applies.
  const onV2 = decision(layers);
  assert.equal(onV2.permitted, false);
  assert.deepEqual(onV2.reason, { source: "environment", cause: "allowlist" });

  // On v4 the same entry applies and permits.
  const onV4 = decision({ ...layers, protocol: "v4" });
  assert.equal(onV4.permitted, true);
  assert.equal(onV4.protocol, "v4");

  // A v4-only denylist entry does not deny a v2 query.
  const v4Deny = decision({
    environment: { entityDenylist: [{ entity: "User", protocols: ["v4"] }] },
    role: {},
  });
  assert.equal(v4Deny.permitted, true);

  // Fields on an entry with protocols omitted restrict both protocols.
  const fieldsBoth = decision({
    protocol: "v4",
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: {},
  });
  assert.deepEqual(fieldsBoth.fields, {
    kind: "restricted",
    fields: new Set(["firstName", "userId"]),
  });
});

test("layered policy: restricted fields with an UNRESOLVED schema fail closed", () => {
  // Any effective restriction needs the schema (for the key set); an absent
  // schema MUST NOT be silently read as "no keys" (allowedProperties principle).
  const result = decision({
    schemaKeys: undefined,
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: {},
  });
  assert.equal(result.permitted, false);
  assert.deepEqual(result.reason, { source: "schema", cause: "unresolved" });
  assert.deepEqual(result.fields, { kind: "restricted", fields: new Set() });

  // Entity denial takes precedence and needs no schema resolution.
  const entityDenied = decision({
    schemaKeys: undefined,
    environment: { entityAllowlist: allow("User", ["firstName"]) },
    role: { entityDenylist: allow("User") },
  });
  assert.equal(entityDenied.permitted, false);
  assert.deepEqual(entityDenied.reason, { source: "role", cause: "denylist" });
});

test("layered policy: an unresolved schema is harmless when no layer restricts fields", () => {
  const result = decision({
    schemaKeys: undefined,
    environment: { entityAllowlist: allow("User") },
    role: { entityAllowlist: allow("User") },
  });
  assert.equal(result.permitted, true);
  assert.deepEqual(result.fields, { kind: "unrestricted" });
});

test("layered policy: validates its internal inputs", () => {
  assert.throws(() => evaluateLayeredPolicy(undefined as never), TypeError);
  assert.throws(() => decision({ entity: "" }), TypeError);
  assert.throws(() => decision({ entity: 42 as never }), TypeError);
  assert.throws(() => decision({ protocol: "v3" as never }), TypeError);
  assert.throws(() => decision({ schemaKeys: [42] as never }), TypeError);
  assert.throws(() => decision({ environment: "all" as never }), TypeError);
  assert.throws(
    () => decision({ environment: { entityDenylist: {} } as never }),
    TypeError,
  );
  assert.throws(
    () => decision({ role: { entityAllowlist: "User" } as never }),
    TypeError,
  );

  const { role: _omitted, ...withoutRole } = base;
  assert.throws(() => evaluateLayeredPolicy(withoutRole as never), TypeError);

  const { environment: _dropped, ...withoutEnvironment } = base;
  assert.throws(() => evaluateLayeredPolicy(withoutEnvironment as never), TypeError);
});

test("reuse pin: isEntityPermitted keeps denylist-wins and empty-is-open semantics", () => {
  const list = allow("User");
  assert.equal(isEntityPermitted(list, list, "User"), false); // denylist wins
  assert.equal(isEntityPermitted(undefined, undefined, "User"), true); // absent = open
  assert.equal(isEntityPermitted([], [], "User"), true); // empty = open
  assert.equal(isEntityPermitted(list, undefined, "EmpJob"), false); // allowlist narrows
});

test("reuse pin: permittedFieldsFor keeps undefined-for-unrestricted semantics", () => {
  assert.equal(permittedFieldsFor(undefined, "User"), undefined);
  assert.equal(permittedFieldsFor([{ entity: "User" }], "User"), undefined);
  assert.equal(permittedFieldsFor([{ entity: "User", fields: [] }], "User"), undefined);
  assert.deepEqual(permittedFieldsFor(allow("User", ["firstName"]), "User"), ["firstName"]);
  assert.equal(
    permittedFieldsFor([{ entity: "User", fields: ["firstName"], protocols: ["v4"] }], "User"),
    undefined,
  );
});
