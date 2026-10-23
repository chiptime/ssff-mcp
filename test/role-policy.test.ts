import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveRole,
  validateTenantRoleConfig,
  type IasIdentity,
  type TenantRoleConfig,
} from "../src/role-policy.js";

const TENANT = "acme";
const ISSUER = "https://acme.ias.example.com";

function tenantConfig(overrides: Partial<TenantRoleConfig> = {}): TenantRoleConfig {
  return {
    tenantId: TENANT,
    issuer: ISSUER,
    roles: [{ name: "reader" }, { name: "hr-analyst" }, { name: "technical" }],
    groupMappings: {
      "acme-readers": "reader",
      "acme-hr": "hr-analyst",
    },
    manualAssignments: [],
    ...overrides,
  };
}

function identity(overrides: Partial<IasIdentity> = {}): IasIdentity {
  return {
    tenantId: TENANT,
    issuer: ISSUER,
    subject: "subject-0001",
    groups: [],
    ...overrides,
  };
}

// --- FR-03: group resolution -------------------------------------------------

test("FR-03: groups that map to one declared role resolve to that role", () => {
  const resolution = resolveEffectiveRole(tenantConfig(), identity({ groups: ["acme-readers"] }));
  assert.deepEqual(resolution, { outcome: "resolved", role: "reader" });
});

test("FR-03: no mapped groups deny with reason no_role", () => {
  const config = tenantConfig();
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: [] })), {
    outcome: "denied",
    reason: "no_role",
  });
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: ["unmapped-group"] })), {
    outcome: "denied",
    reason: "no_role",
  });
});

test("FR-03: groups mapping to several distinct roles deny as ambiguous", () => {
  const resolution = resolveEffectiveRole(
    tenantConfig(),
    identity({ groups: ["acme-readers", "acme-hr"] }),
  );
  assert.deepEqual(resolution, { outcome: "denied", reason: "ambiguous_roles" });
});

test("FR-03: several groups mapping to the same role yield that single role", () => {
  const config = tenantConfig({
    groupMappings: { "grp-a": "reader", "grp-b": "reader" },
  });
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: ["grp-a", "grp-b"] })), {
    outcome: "resolved",
    role: "reader",
  });
});

test("FR-03: resolution is deterministic regardless of group order or repetition", () => {
  const config = tenantConfig();
  const repeatedAmbiguous = resolveEffectiveRole(
    config,
    identity({ groups: ["acme-hr", "acme-readers", "acme-hr"] }),
  );
  assert.deepEqual(repeatedAmbiguous, { outcome: "denied", reason: "ambiguous_roles" });
  const repeatedSingle = resolveEffectiveRole(
    config,
    identity({ groups: ["acme-readers", "acme-readers"] }),
  );
  assert.deepEqual(repeatedSingle, { outcome: "resolved", role: "reader" });
});

// --- FR-04: manual assignment precedence --------------------------------------

test("FR-04: a manual assignment to a declared role prevails over groups", () => {
  const config = tenantConfig({
    manualAssignments: [{ subject: "subject-0001", role: "hr-analyst" }],
  });
  // Groups alone would resolve "reader"; the manual assignment must win.
  const resolution = resolveEffectiveRole(config, identity({ groups: ["acme-readers"] }));
  assert.deepEqual(resolution, { outcome: "resolved", role: "hr-analyst" });
});

test("FR-04: removing the manual assignment re-evaluates the group mapping", () => {
  const withAssignment = tenantConfig({
    manualAssignments: [{ subject: "subject-0001", role: "hr-analyst" }],
  });
  assert.deepEqual(
    resolveEffectiveRole(withAssignment, identity({ groups: ["acme-readers"] })),
    { outcome: "resolved", role: "hr-analyst" },
  );
  // Same identity on the next evaluation, assignment removed: groups decide again.
  assert.deepEqual(resolveEffectiveRole(tenantConfig(), identity({ groups: ["acme-readers"] })), {
    outcome: "resolved",
    role: "reader",
  });
});

// --- FR-05: invalid manual reference ------------------------------------------

test("FR-05: a manual assignment to an undeclared role denies with NO group fallback", () => {
  const config = tenantConfig({
    roles: [{ name: "reader" }],
    groupMappings: { "acme-readers": "reader" },
    manualAssignments: [{ subject: "subject-0001", role: "role-deleted-from-config" }],
  });
  // Groups would authorize as "reader"; the dangling manual reference must deny instead.
  const resolution = resolveEffectiveRole(config, identity({ groups: ["acme-readers"] }));
  assert.deepEqual(resolution, { outcome: "denied", reason: "invalid_manual_role" });
});

// --- FR-06: the technical role is an ordinary role -----------------------------

test("FR-06: the technical role resolves like any other role, by assignment or group", () => {
  const byAssignment = tenantConfig({
    manualAssignments: [{ subject: "subject-0001", role: "technical" }],
  });
  assert.deepEqual(resolveEffectiveRole(byAssignment, identity()), {
    outcome: "resolved",
    role: "technical",
  });

  const byGroup = tenantConfig({
    groupMappings: { "acme-ops-batch": "technical" },
  });
  assert.deepEqual(resolveEffectiveRole(byGroup, identity({ groups: ["acme-ops-batch"] })), {
    outcome: "resolved",
    role: "technical",
  });
});

test("FR-06: an authenticated user without assignment or mapping gets no automatic role", () => {
  const config = tenantConfig();
  assert.deepEqual(resolveEffectiveRole(config, identity()), {
    outcome: "denied",
    reason: "no_role",
  });
  // Belonging to some unrelated IdP group changes nothing.
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: ["all-employees"] })), {
    outcome: "denied",
    reason: "no_role",
  });
});

// --- Trust boundary: tenant and issuer binding ---------------------------------

test("an identity bound to another tenant is denied before any lookup", () => {
  const config = tenantConfig({
    manualAssignments: [{ subject: "subject-0001", role: "reader" }],
  });
  // Same subject AND a mapped group: nothing from the other tenant may match.
  const foreign = identity({ tenantId: "globex", groups: ["acme-readers"] });
  assert.deepEqual(resolveEffectiveRole(config, foreign), {
    outcome: "denied",
    reason: "identity_mismatch",
  });
});

test("an identity from another issuer is denied even for the same tenant", () => {
  const config = tenantConfig({
    manualAssignments: [{ subject: "subject-0001", role: "reader" }],
  });
  const foreign = identity({ issuer: "https://evil.example.com", groups: ["acme-readers"] });
  assert.deepEqual(resolveEffectiveRole(config, foreign), {
    outcome: "denied",
    reason: "identity_mismatch",
  });
});

test("issuer and tenant matching is exact: no trimming or URL normalization", () => {
  const config = tenantConfig(); // issuer without trailing slash
  const slash = identity({ issuer: `${ISSUER}/`, groups: ["acme-readers"] });
  assert.deepEqual(resolveEffectiveRole(config, slash), {
    outcome: "denied",
    reason: "identity_mismatch",
  });
});

test("roles are tenant-local: the same role name in two tenants resolves independently", () => {
  const acme = tenantConfig({ groupMappings: { "acme-readers": "reader" } });
  const globex: TenantRoleConfig = {
    tenantId: "globex",
    issuer: "https://globex.ias.example.com",
    roles: [{ name: "reader" }],
    groupMappings: { "globex-readers": "reader" },
    manualAssignments: [],
  };
  assert.deepEqual(resolveEffectiveRole(acme, identity({ groups: ["acme-readers"] })), {
    outcome: "resolved",
    role: "reader",
  });
  assert.deepEqual(
    resolveEffectiveRole(
      globex,
      identity({
        tenantId: "globex",
        issuer: "https://globex.ias.example.com",
        groups: ["globex-readers"],
      }),
    ),
    { outcome: "resolved", role: "reader" },
  );
  // A globex group never resolves inside the acme configuration.
  assert.deepEqual(resolveEffectiveRole(acme, identity({ groups: ["globex-readers"] })), {
    outcome: "denied",
    reason: "no_role",
  });
});

// --- Fail-closed configuration validation ---------------------------------------

test("a well-formed configuration passes validation", () => {
  assert.equal(validateTenantRoleConfig(tenantConfig()), undefined);
});

test("a group mapping to an undeclared role is malformed and resolution fails closed", () => {
  const config = tenantConfig({ groupMappings: { "acme-readers": "ghost-role" } });
  const error = validateTenantRoleConfig(config);
  assert.ok(error !== undefined);
  assert.match(error.message, /ghost-role/);
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: ["acme-readers"] })), {
    outcome: "denied",
    reason: "malformed_config",
  });
});

test("duplicate declared role names are malformed and resolution fails closed", () => {
  const config = tenantConfig({ roles: [{ name: "reader" }, { name: "reader" }] });
  assert.ok(validateTenantRoleConfig(config) !== undefined);
  assert.deepEqual(resolveEffectiveRole(config, identity()), {
    outcome: "denied",
    reason: "malformed_config",
  });
});

test("duplicate manual assignment subjects are malformed and resolution fails closed", () => {
  const config = tenantConfig({
    manualAssignments: [
      { subject: "subject-0001", role: "reader" },
      { subject: "subject-0001", role: "hr-analyst" },
    ],
  });
  assert.ok(validateTenantRoleConfig(config) !== undefined);
  assert.deepEqual(resolveEffectiveRole(config, identity()), {
    outcome: "denied",
    reason: "malformed_config",
  });
});

test("structurally invalid configurations are malformed, never a crash or a guess", () => {
  const bad: TenantRoleConfig[] = [
    tenantConfig({ tenantId: "" }),
    tenantConfig({ tenantId: "   " }),
    tenantConfig({ issuer: "" }),
    tenantConfig({ roles: [{ name: "" }] }),
    tenantConfig({ groupMappings: { "": "reader" } }),
    tenantConfig({ manualAssignments: [{ subject: "", role: "reader" }] }),
  ];
  for (const config of bad) {
    assert.ok(validateTenantRoleConfig(config) !== undefined, JSON.stringify(config));
  }
  // Parts missing at runtime (untyped callers) fail closed as well.
  const missingRoles = { ...tenantConfig(), roles: undefined } as unknown as TenantRoleConfig;
  assert.ok(validateTenantRoleConfig(missingRoles) !== undefined);
  const missingMappings = { ...tenantConfig(), groupMappings: undefined } as unknown as TenantRoleConfig;
  assert.ok(validateTenantRoleConfig(missingMappings) !== undefined);
  const missingAssignments = {
    ...tenantConfig(),
    manualAssignments: undefined,
  } as unknown as TenantRoleConfig;
  assert.deepEqual(resolveEffectiveRole(missingAssignments, identity()), {
    outcome: "denied",
    reason: "malformed_config",
  });
});

test("a configuration with zero declared roles is valid but denies every identity", () => {
  const config: TenantRoleConfig = {
    tenantId: TENANT,
    issuer: ISSUER,
    roles: [],
    groupMappings: {},
    manualAssignments: [],
  };
  assert.equal(validateTenantRoleConfig(config), undefined);
  assert.deepEqual(resolveEffectiveRole(config, identity({ groups: ["acme-readers"] })), {
    outcome: "denied",
    reason: "no_role",
  });
});

// --- Prototype safety ------------------------------------------------------------

test("prototype-named groups never resolve through inherited properties", () => {
  const config = tenantConfig();
  const resolution = resolveEffectiveRole(
    config,
    identity({ groups: ["constructor", "__proto__", "toString", "hasOwnProperty"] }),
  );
  assert.deepEqual(resolution, { outcome: "denied", reason: "no_role" });
});
