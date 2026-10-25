import test from "node:test";
import assert from "node:assert/strict";
import { intersectEntityPolicies } from "../src/policy-composition.js";
import {
  isEntityAllowed,
  isEntityPermitted,
  isFieldPermitted,
  permittedFieldsFor,
  type AllowlistEntry,
  type CompositeEntityPolicy,
} from "../src/allowlist.js";
import { evaluateLayeredPolicy, type PolicyLayer } from "../src/layered-policy.js";
import {
  checkExpandRoutes,
  checkExpressionReferences,
  checkNavigationPath,
  expressionReferences,
  type NavigationLookup,
} from "../src/allowlist-navigation.js";
import {
  allowedProperties,
  FieldNotPermittedError,
  filterSchemaProperties,
  redactValue,
  type SchemaLookup,
} from "../src/fields.js";
import { MetadataService } from "../src/metadata.js";
import { envTargetFor } from "../src/http.js";
import { isSanitizedError } from "../src/errors.js";
import { mdfMetadataXml, recordingFetch, xmlResponse } from "./helpers.js";

/**
 * Policy composition (S4, FR-08): `intersectEntityPolicies` folds the
 * ENVIRONMENT ceiling and the ROLE narrowing into ONE value accepted wherever
 * a legacy `entityAllowlist` array is accepted.
 *
 * Invariants under test:
 *
 * - Entity: BOTH layers must permit; a denylist in either layer wins; a
 *   denylist passed BESIDE the composite still wins; an empty entity
 *   intersection denies every entity and is never materialized as a legacy
 *   `[]` (which would mean "unrestricted").
 * - Fields: `undefined` only when BOTH layers are unrestricted; otherwise the
 *   intersection, INCLUDING the empty one. `[]` stays restricted downstream:
 *   `allowedProperties` turns it into "schema keys only" and fails closed on
 *   an unresolved schema, exactly like `evaluateLayeredPolicy`.
 * - Navigation, expand, expression references, the Custom MDF catalog and
 *   schema/record redaction all enforce both layers through the SAME helpers.
 * - Legacy arrays keep their documented semantics, byte for byte.
 */

const allow = (entity: string, fields?: string[]): AllowlistEntry[] =>
  fields === undefined ? [{ entity }] : [{ entity, fields }];

// --- Shared in-memory schemas (fields/navigation/metadata surfaces) ---------

const SCHEMAS: Record<
  string,
  { keys: string[]; properties: Array<{ name: string }>; navigationProperties: Array<{ name: string; targetEntitySet: string }> }
> = {
  User: {
    keys: ["userId"],
    properties: [{ name: "userId" }, { name: "username" }, { name: "email" }],
    navigationProperties: [{ name: "empInfo", targetEntitySet: "EmpEmployment" }],
  },
  EmpEmployment: {
    keys: ["userId"],
    properties: [{ name: "userId" }, { name: "startDate" }, { name: "endDate" }],
    navigationProperties: [],
  },
};

const schemaLookup: SchemaLookup = async (entitySet) => SCHEMAS[entitySet];

const navigationLookup: NavigationLookup = async (fromEntitySet, navigationName) =>
  SCHEMAS[fromEntitySet]?.navigationProperties.find((nav) => nav.name === navigationName)
    ?.targetEntitySet;

function asComposite(policy: ReturnType<typeof intersectEntityPolicies>): CompositeEntityPolicy {
  assert.ok(!Array.isArray(policy), "composite policy must not be an array");
  return policy as CompositeEntityPolicy;
}

// --- Factory -----------------------------------------------------------------

test("intersectEntityPolicies returns a frozen composite preserving both layers by reference", () => {
  const environment: PolicyLayer = { entityAllowlist: [{ entity: "User" }] };
  const role: PolicyLayer = { entityDenylist: [{ entity: "EmpJob" }] };
  const policy = intersectEntityPolicies(environment, role);
  const composite = asComposite(policy);
  assert.equal(composite.kind, "composite");
  assert.equal(composite.environment, environment);
  assert.equal(composite.role, role);
  assert.ok(Object.isFrozen(composite), "the composite wrapper is frozen");
});

test("intersectEntityPolicies rejects malformed layers with a TypeError", () => {
  const valid: PolicyLayer = {};
  assert.throws(() => intersectEntityPolicies(null as unknown as PolicyLayer, valid), TypeError);
  assert.throws(() => intersectEntityPolicies([] as unknown as PolicyLayer, valid), TypeError);
  assert.throws(
    () => intersectEntityPolicies({ entityAllowlist: "User" } as unknown as PolicyLayer, valid),
    TypeError,
  );
  assert.throws(
    () => intersectEntityPolicies(valid, { entityDenylist: {} } as unknown as PolicyLayer),
    TypeError,
  );
  // Undefined lists are the "narrows nothing" default and must be accepted.
  assert.doesNotThrow(() => intersectEntityPolicies({}, {}));
});

// --- Entity decisions ----------------------------------------------------------

test("composite entity permission: BOTH layers must allow the entity", () => {
  const bothAllow = intersectEntityPolicies(
    { entityAllowlist: allow("User") },
    { entityAllowlist: allow("User") },
  );
  assert.equal(isEntityAllowed(bothAllow, "User"), true);

  const roleNarrows = intersectEntityPolicies(
    { entityAllowlist: allow("User") },
    { entityAllowlist: allow("EmpJob") },
  );
  assert.equal(isEntityAllowed(roleNarrows, "User"), false);

  const environmentNarrows = intersectEntityPolicies(
    { entityAllowlist: allow("EmpJob") },
    { entityAllowlist: allow("User") },
  );
  assert.equal(isEntityAllowed(environmentNarrows, "User"), false);
});

test("composite entity permission: a denylist in EITHER layer wins", () => {
  const environmentDenies = intersectEntityPolicies(
    { entityAllowlist: allow("User"), entityDenylist: allow("User") },
    { entityAllowlist: allow("User") },
  );
  assert.equal(isEntityAllowed(environmentDenies, "User"), false);

  const roleDenies = intersectEntityPolicies(
    { entityAllowlist: allow("User") },
    { entityAllowlist: allow("User"), entityDenylist: allow("User") },
  );
  assert.equal(isEntityAllowed(roleDenies, "User"), false);
});

test("composite keeps a denylist passed beside it authoritative (environment entityDenylist)", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpJob")].flat() },
    { entityAllowlist: [allow("User"), allow("EmpJob")].flat() },
  );
  // Both layers permit EmpJob; the denylist kept beside the composite wins.
  assert.equal(isEntityPermitted(policy, allow("EmpJob"), "EmpJob"), false);
  // Without it, both layers permit: allowed.
  assert.equal(isEntityPermitted(policy, undefined, "EmpJob"), true);
  assert.equal(isEntityPermitted(policy, allow("EmpJob"), "User"), true);

  // The denylist folded INTO the environment layer denies on its own too
  // (intersectEntityPolicies expects the environment's own lists).
  const folded = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpJob")].flat(), entityDenylist: allow("EmpJob") },
    { entityAllowlist: [allow("User"), allow("EmpJob")].flat() },
  );
  assert.equal(isEntityPermitted(folded, undefined, "EmpJob"), false);
});

test("no common entity: every entity is denied, never legacy-unrestricted", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: allow("FOOBar") },
    { entityAllowlist: allow("cust_Equipo") },
  );
  for (const entity of ["FOOBar", "cust_Equipo", "User"]) {
    assert.equal(isEntityAllowed(policy, entity), false, entity);
    assert.equal(isEntityPermitted(policy, undefined, entity), false, entity);
  }
});

test("composite protocol entries apply per layer, exactly like the evaluator", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", protocols: ["v4"] }] },
    { entityAllowlist: allow("User") },
  );
  assert.equal(isEntityAllowed(policy, "User", "v2"), false);
  assert.equal(isEntityAllowed(policy, "User", "v4"), true);
});

test("a role layer can never widen the environment ceiling", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: allow("User") },
    { entityAllowlist: [allow("User"), allow("EmpJob")].flat() },
  );
  assert.equal(isEntityAllowed(policy, "User"), true);
  assert.equal(isEntityAllowed(policy, "EmpJob"), false);
});

test("a malformed policy value fails closed with a TypeError", () => {
  assert.throws(
    () => isEntityAllowed("nope" as unknown as AllowlistEntry[], "User"),
    TypeError,
  );
  assert.throws(
    () => permittedFieldsFor({ kind: "other" } as unknown as AllowlistEntry[], "User"),
    TypeError,
  );
});

// --- Fields --------------------------------------------------------------------

test("composite fields: undefined only when BOTH layers are unrestricted", () => {
  const bothOpen = intersectEntityPolicies({}, {});
  assert.equal(permittedFieldsFor(bothOpen, "User"), undefined);

  const emptyArraysAreOpen = intersectEntityPolicies(
    { entityAllowlist: [] },
    { entityAllowlist: [] },
  );
  assert.equal(permittedFieldsFor(emptyArraysAreOpen, "User"), undefined);
});

test("composite fields: a restriction in ONE layer narrows on its own", () => {
  const environmentRestricts = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username", "email"] }] },
    {},
  );
  assert.deepEqual(permittedFieldsFor(environmentRestricts, "User"), ["username", "email"]);

  const roleRestricts = intersectEntityPolicies(
    {},
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  assert.deepEqual(permittedFieldsFor(roleRestricts, "User"), ["email"]);
});

test("composite fields: empty entry fields keep their layer unrestricted (legacy semantics)", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: [] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  // `fields: []` narrows nothing in the environment layer; only the role list applies.
  assert.deepEqual(permittedFieldsFor(policy, "User"), ["email"]);
});

test("composite fields: both layers restrict to their intersection", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username", "email"] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email", "startDate"] }] },
  );
  assert.deepEqual(permittedFieldsFor(policy, "User"), ["email"]);
});

test("composite fields: a DISJOINT intersection is [] and stays RESTRICTED", () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username"] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  const fields = permittedFieldsFor(policy, "User");
  assert.notEqual(fields, undefined, "[] must never decay to legacy-unrestricted");
  assert.deepEqual(fields, []);
  // Restricted-empty denies every field through the pure helper. Schema keys
  // are re-added only by the schema-aware path (allowedProperties), exactly
  // like the legacy single-layer behavior.
  assert.equal(isFieldPermitted(policy, "User", "username"), false);
  assert.equal(isFieldPermitted(policy, "User", "userId"), false);
  // This `!== undefined` is the exact input the XML downgrade decision uses.
  assert.ok(permittedFieldsFor(policy, "User") !== undefined);
});

test("allowedProperties: intersection plus schema keys; disjoint means keys-only", async () => {
  const overlapping = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username", "email"] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  assert.deepEqual(await allowedProperties(overlapping, "User", schemaLookup), new Set(["email", "userId"]));

  const disjoint = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username"] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  // Keys-only: the explicit empty intersection is restricted, and the schema
  // keys are what remain readable.
  assert.deepEqual(await allowedProperties(disjoint, "User", schemaLookup), new Set(["userId"]));
});

test("allowedProperties: restricted fields with an UNRESOLVED schema fail closed; unrestricted do not", async () => {
  const lookup: SchemaLookup = async () => undefined;
  const restricted = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "Ghost", fields: ["a"] }] },
    { entityAllowlist: allow("Ghost") },
  );
  await assert.rejects(
    () => allowedProperties(restricted, "Ghost", lookup),
    (error: unknown) => error instanceof FieldNotPermittedError,
  );

  const open = intersectEntityPolicies({ entityAllowlist: allow("Ghost") }, {});
  assert.equal(await allowedProperties(open, "Ghost", lookup), undefined);
});

test("redactValue drops fields denied by either layer and keeps the schema keys", async () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["username", "email"] }] },
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
  );
  const record = { userId: "u1", username: "alice", email: "a@example.com" };
  assert.deepEqual(
    await redactValue(record, "User", policy, schemaLookup, navigationLookup),
    { userId: "u1", email: "a@example.com" },
  );
});

test("redactValue redacts expanded navigation against the target entity's composite policy", async () => {
  const policy = intersectEntityPolicies(
    {
      entityAllowlist: [
        { entity: "User", fields: ["username"] },
        { entity: "EmpEmployment", fields: ["startDate", "endDate"] },
      ],
    },
    { entityAllowlist: [{ entity: "User" }, { entity: "EmpEmployment", fields: ["endDate"] }] },
  );
  const payload = {
    userId: "u1",
    username: "alice",
    email: "a@example.com",
    empInfo: { userId: "u1", startDate: "2020-01-01", endDate: "2030-01-01" },
  };
  assert.deepEqual(
    await redactValue(payload, "User", policy, schemaLookup, navigationLookup),
    {
      userId: "u1",
      username: "alice",
      empInfo: { userId: "u1", endDate: "2030-01-01" },
    },
  );
});

test("filterSchemaProperties hides schema properties outside the composite-allowed set", async () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [{ entity: "User", fields: ["email"] }] },
    {},
  );
  const allowed = await allowedProperties(policy, "User", schemaLookup);
  const schema = { properties: [{ name: "userId" }, { name: "username" }, { name: "email" }] };
  assert.deepEqual(filterSchemaProperties(schema, allowed), {
    properties: [{ name: "userId" }, { name: "email" }],
  });
});

// --- Navigation / expand / expressions -----------------------------------------

test("checkNavigationPath denies a hop only one layer permits", async () => {
  const deniedByRole = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
    { entityDenylist: allow("EmpEmployment") },
  );
  assert.deepEqual(await checkNavigationPath(["User", "empInfo"], deniedByRole, undefined, navigationLookup), {
    kind: "denied",
    entitySet: "EmpEmployment",
  });

  const deniedByEnvironment = intersectEntityPolicies(
    { entityAllowlist: allow("User") },
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
  );
  assert.deepEqual(
    await checkNavigationPath(["User", "empInfo"], deniedByEnvironment, undefined, navigationLookup),
    { kind: "denied", entitySet: "EmpEmployment" },
  );

  const permitted = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
  );
  assert.deepEqual(
    await checkNavigationPath(["User", "empInfo"], permitted, undefined, navigationLookup),
    { kind: "permitted", reached: "EmpEmployment" },
  );
});

test("checkExpandRoutes enforces both layers on every route", async () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
    { entityDenylist: allow("EmpEmployment") },
  );
  assert.deepEqual(await checkExpandRoutes("User", [["empInfo"]], policy, undefined, navigationLookup), {
    kind: "denied",
    entitySet: "EmpEmployment",
  });
});

test("checkExpressionReferences rejects names and paths reaching a role-denied entity", async () => {
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("User"), allow("EmpEmployment")].flat() },
    { entityDenylist: allow("EmpEmployment") },
  );
  // A bare $select=empInfo names the denied destination.
  assert.deepEqual(
    await checkExpressionReferences("User", [{ kind: "name", name: "empInfo" }], policy, undefined, navigationLookup),
    { kind: "denied", entitySet: "EmpEmployment" },
  );
  // A path reference walks its navigation segments. The scanner reports every
  // identifier outside literals, operators included.
  const pathRefs = expressionReferences("empInfo/startDate eq null");
  assert.deepEqual(pathRefs, [
    { kind: "path", segments: ["empInfo", "startDate"] },
    { kind: "name", name: "eq" },
    { kind: "name", name: "null" },
  ]);
  assert.deepEqual(
    await checkExpressionReferences("User", pathRefs, policy, undefined, navigationLookup),
    { kind: "denied", entitySet: "EmpEmployment" },
  );
});

// --- Catalog visibility --------------------------------------------------------

const mdfEnv = envTargetFor(
  { baseUrl: "https://tenant-a.example.com", auth: { type: "basic", username: "u", password: "p" } },
  "a",
);

function mdfService() {
  const rec = recordingFetch(() => xmlResponse(mdfMetadataXml()));
  return { service: new MetadataService({ fetchImpl: rec.fetch }), requests: rec.requests };
}

test("listCustomMdf intersects both layers; the role never widens the environment", async () => {
  const { service: svc } = mdfService();
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("cust_Equipo"), allow("cust_Prendas")].flat() },
    { entityAllowlist: allow("cust_Prendas") },
  );
  const list = await svc.listCustomMdf(mdfEnv, "a", policy);
  assert.deepEqual(list.map((item) => item.name), ["cust_Prendas"]);
});

test("listCustomMdf: a role denylist subtracts from the environment's catalog", async () => {
  const { service: svc } = mdfService();
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("cust_Equipo"), allow("cust_Prendas")].flat() },
    { entityDenylist: allow("cust_Equipo") },
  );
  const list = await svc.listCustomMdf(mdfEnv, "a", policy);
  assert.deepEqual(list.map((item) => item.name), ["cust_Prendas"]);
});

test("getCustomMdfDetails throws ENTITY_NOT_ALLOWED for an entity one layer denies", async () => {
  const { service: svc } = mdfService();
  const policy = intersectEntityPolicies(
    { entityAllowlist: [allow("cust_Equipo"), allow("cust_Prendas")].flat() },
    { entityAllowlist: allow("cust_Prendas") },
  );
  await assert.rejects(
    () => svc.getCustomMdfDetails(mdfEnv, "a", "cust_Equipo", policy),
    (error: unknown) => isSanitizedError(error) && error.code === "ENTITY_NOT_ALLOWED",
  );
  // An entity both layers permit is still served.
  assert.ok((await svc.getCustomMdfDetails(mdfEnv, "a", "cust_Prendas", policy)) !== undefined);
});

// --- Equivalence with evaluateLayeredPolicy ------------------------------------

test("composite decisions match evaluateLayeredPolicy across a matrix of layers, entities and protocols", () => {
  const layers: PolicyLayer[] = [
    {},
    { entityAllowlist: [] },
    { entityAllowlist: [{ entity: "User" }] },
    { entityAllowlist: [{ entity: "User", fields: ["username"] }] },
    { entityAllowlist: [{ entity: "User", fields: [] }] },
    { entityAllowlist: [{ entity: "EmpEmployment" }] },
    { entityDenylist: [{ entity: "User" }] },
    { entityAllowlist: [{ entity: "User" }], entityDenylist: [{ entity: "User", protocols: ["v4"] }] },
    { entityAllowlist: [{ entity: "User", protocols: ["v4"] }] },
  ];
  const entities = ["User", "EmpEmployment", "EmpJob"];
  const protocols = ["v2", "v4"] as const;

  for (const environment of layers) {
    for (const role of layers) {
      const policy = intersectEntityPolicies(environment, role);
      for (const entity of entities) {
        for (const protocol of protocols) {
          const label = JSON.stringify({ environment, role, entity, protocol });
          const decision = evaluateLayeredPolicy({ entity, protocol, schemaKeys: [], environment, role });
          assert.equal(isEntityAllowed(policy, entity, protocol), decision.permitted, label);
          assert.equal(isEntityPermitted(policy, undefined, entity, protocol), decision.permitted, label);

          // Field outcomes are only observable for a PERMITTED entity: a
          // denied entity is rejected by the entity gate before any field
          // surface runs, and the evaluator reports "nothing readable" there.
          if (!decision.permitted) {
            continue;
          }
          const fields = permittedFieldsFor(policy, entity, protocol);
          if (decision.fields.kind === "unrestricted") {
            assert.equal(fields, undefined, label);
          } else {
            assert.ok(fields !== undefined, label);
            assert.deepEqual([...decision.fields.fields].sort(), [...fields].sort(), label);
          }
        }
      }
    }
  }
});

// --- Legacy arrays keep their documented semantics ------------------------------

test("legacy arrays: empty or absent narrows nothing", () => {
  assert.equal(isEntityAllowed(undefined, "User"), true);
  assert.equal(isEntityAllowed([], "User"), true);
  assert.equal(isEntityPermitted([], undefined, "User"), true);
  assert.equal(permittedFieldsFor(undefined, "User"), undefined);
  assert.equal(permittedFieldsFor([], "User"), undefined);
});

test("legacy arrays: allowlist, denylist-wins and protocol semantics are unchanged", () => {
  assert.equal(isEntityAllowed(allow("User"), "User"), true);
  assert.equal(isEntityAllowed(allow("User"), "EmpJob"), false);
  assert.equal(isEntityAllowed([{ entity: "User", protocols: ["v4"] }], "User", "v2"), false);
  assert.equal(isEntityAllowed([{ entity: "User", protocols: ["v4"] }], "User", "v4"), true);
  assert.equal(isEntityPermitted(allow("User"), allow("User"), "User"), false);
  assert.equal(
    isEntityPermitted(allow("User"), [{ entity: "User", protocols: ["v4"] }], "User", "v2"),
    true,
  );
});

test("legacy arrays: field semantics are unchanged", () => {
  assert.equal(permittedFieldsFor([{ entity: "User", fields: [] }], "User"), undefined);
  assert.deepEqual(permittedFieldsFor([{ entity: "User", fields: ["a"] }], "User"), ["a"]);
  assert.equal(permittedFieldsFor([{ entity: "EmpJob", fields: ["a"] }], "User"), undefined);
  assert.equal(isFieldPermitted([{ entity: "User", fields: ["a"] }], "User", "a"), true);
  assert.equal(isFieldPermitted([{ entity: "User", fields: ["a"] }], "User", "b"), false);
  assert.equal(isFieldPermitted(undefined, "User", "anything"), true);
});
