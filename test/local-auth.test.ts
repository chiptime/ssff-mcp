/**
 * Local auth resolver rules (S1–S3, S6 of odd/tasks/local-user-tokens.md):
 *
 * - Named users resolve with their role and a scope derived from the role envs
 *   sorted, intersected with the tenant's declared environments. No default role.
 * - Expired/revoked tokens and disabled users NEVER authenticate — and never
 *   fall back to legacy API-key resolution.
 * - Token hash collisions (named vs named, named vs legacy) fail closed, even
 *   for expired/revoked/disabled records: a rejected named token must not gain
 *   legacy access.
 * - Legacy credentials keep the exact resolveTenant semantics (innermost wins,
 *   cross-tenant ambiguity => null).
 * - Session stability (S3): identity is authType/tenant/user; rotation keeps it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasCredentialCollision,
  resolveHostedAuth,
  type HostedAuthDirectory,
  type LocalToken,
} from "../src/local-auth.js";
import { resolveTenant, sha256Hex } from "../src/tenancy.js";

const digest = (token: string): string => sha256Hex(token);

/** Far-future and long-past expiry instants (deterministic tests). */
const FUTURE = "2049-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

function token(id: string, tokenValue: string, expiresAt = FUTURE, revoked = false): LocalToken {
  return { id, hash: digest(tokenValue), expiresAt, revoked };
}

function directory(): HostedAuthDirectory {
  return {
    legacyKeys: {
      acme: {
        apiKeyHash: digest("acme-client-key"),
        environments: { dev: digest("acme-dev-key"), prod: undefined },
      },
      globex: { environments: { prod: digest("globex-prod-key") } },
    },
    tenants: {
      acme: {
        environments: ["dev", "prod"],
        roles: {
          reader: { environments: ["dev", "prod"] },
          prodOnly: { environments: ["prod"], entityDenylist: [{ entity: "PerPersonal" }] },
        },
        users: {
          alice: { role: "reader", enabled: true, tokens: [token("alice-1", "alice-token-1")] },
          bob: { role: "prodOnly", enabled: true, tokens: [token("bob-1", "bob-token-1")] },
        },
      },
      globex: {
        environments: ["prod"],
        roles: { reader: { environments: ["prod"] } },
        users: {
          carol: { role: "reader", enabled: true, tokens: [token("carol-1", "carol-token-1")] },
        },
      },
    },
    rawConfig: "{}",
  };
}

// ---------------------------------------------------------------------------
// Legacy path: existing API keys keep resolveTenant semantics.
// ---------------------------------------------------------------------------

test("a legacy client-wide key resolves as legacy_key with the resolveTenant scope", () => {
  const dir = directory();
  const resolution = resolveHostedAuth(dir, "acme-client-key");
  const expected = resolveTenant(dir.legacyKeys, "acme-client-key");
  assert.ok(expected !== null);
  assert.deepEqual(resolution, {
    authType: "legacy_key",
    tenantId: "acme",
    allowedEnvironments: expected.allowedEnvironments,
    credentialDigest: digest("acme-client-key"),
  });
  assert.deepEqual(resolution?.allowedEnvironments, ["dev", "prod"]);
});

test("a legacy per-environment key keeps the innermost scope", () => {
  const resolution = resolveHostedAuth(directory(), "acme-dev-key");
  assert.deepEqual(resolution, {
    authType: "legacy_key",
    tenantId: "acme",
    allowedEnvironments: ["dev"],
    credentialDigest: digest("acme-dev-key"),
  });
});

test("legacy-vs-legacy ambiguity keeps resolveTenant semantics: null", () => {
  const shared = digest("shared-legacy-key");
  const dir: HostedAuthDirectory = {
    legacyKeys: {
      acme: { apiKeyHash: shared, environments: {} },
      globex: { apiKeyHash: shared, environments: {} },
    },
    tenants: {},
    rawConfig: "{}",
  };
  assert.equal(resolveTenant(dir.legacyKeys, "shared-legacy-key"), null);
  assert.equal(resolveHostedAuth(dir, "shared-legacy-key"), null);
});

test("absent or empty tokens are rejected before any comparison", () => {
  assert.equal(resolveHostedAuth(directory(), undefined), null);
  assert.equal(resolveHostedAuth(directory(), ""), null);
});

test("an unknown token resolves to null, never to a default tenant", () => {
  const dir = directory();
  assert.equal(resolveHostedAuth(dir, "no-such-token"), null);
  // Near-miss of a real token (case change) must not match either.
  assert.equal(resolveHostedAuth(dir, "Alice-Token-1"), null);
});

// ---------------------------------------------------------------------------
// Named path: valid personal tokens.
// ---------------------------------------------------------------------------

test("a valid named token resolves as named_user with its role and sorted scope", () => {
  const resolution = resolveHostedAuth(directory(), "alice-token-1");
  assert.deepEqual(resolution, {
    authType: "named_user",
    tenantId: "acme",
    userId: "alice",
    roleName: "reader",
    allowedEnvironments: ["dev", "prod"],
    role: { environments: ["dev", "prod"] },
    credentialDigest: digest("alice-token-1"),
    tokenId: "alice-1",
  });
});

test("the named role record (with its entity lists) travels with the resolution", () => {
  const resolution = resolveHostedAuth(directory(), "bob-token-1");
  assert.ok(resolution !== null && resolution.authType === "named_user");
  assert.equal(resolution.roleName, "prodOnly");
  assert.deepEqual(resolution.role.entityDenylist, [{ entity: "PerPersonal" }]);
  assert.deepEqual(resolution.allowedEnvironments, ["prod"]);
});

test("named scopes are the role envs SORTED, intersected with the declared environments", () => {
  const dir = directory();
  // Role declares its envs out of order; the resolution sorts them.
  dir.tenants.acme!.roles.reader = { environments: ["prod", "dev"] };
  const resolution = resolveHostedAuth(dir, "alice-token-1");
  assert.ok(resolution !== null && resolution.authType === "named_user");
  assert.deepEqual(resolution.allowedEnvironments, ["dev", "prod"]);
});

test("a role env the tenant does not declare is dropped (defensive intersection)", () => {
  // A hand-built directory (loader would reject this): only declared envs count.
  const dir = directory();
  dir.tenants.acme!.roles.reader = { environments: ["dev", "staging"] };
  const resolution = resolveHostedAuth(dir, "alice-token-1");
  assert.ok(resolution !== null && resolution.authType === "named_user");
  assert.deepEqual(resolution.allowedEnvironments, ["dev"]);
});

test("no default role: a user whose role is not declared resolves to null", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice = { role: "ghost", enabled: true, tokens: [token("alice-1", "alice-token-1")] };
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

test("each tenant's named tokens stay isolated per tenant and user", () => {
  const dir = directory();
  const carol = resolveHostedAuth(dir, "carol-token-1");
  assert.ok(carol !== null && carol.authType === "named_user");
  assert.equal(carol.tenantId, "globex");
  assert.equal(carol.userId, "carol");
  // And alice's token never reaches globex.
  const alice = resolveHostedAuth(dir, "alice-token-1");
  assert.ok(alice !== null && alice.authType === "named_user");
  assert.equal(alice.tenantId, "acme");
});

// ---------------------------------------------------------------------------
// Expiry, revocation, disabled users — with NO legacy fallback.
// ---------------------------------------------------------------------------

test("an expired token never authenticates: now >= expiresAt is expired", () => {
  const dir = directory();
  const expiresAt = "2030-06-01T00:00:00Z";
  dir.tenants.acme!.users.alice = { role: "reader", enabled: true, tokens: [token("alice-1", "alice-token-1", expiresAt)] };
  const boundary = Date.parse(expiresAt);
  assert.equal(resolveHostedAuth(dir, "alice-token-1", boundary), null);
  assert.equal(resolveHostedAuth(dir, "alice-token-1", boundary + 1), null);
  const before = resolveHostedAuth(dir, "alice-token-1", boundary - 1);
  assert.ok(before !== null && before.authType === "named_user");
});

test("expiry honors the timezone offset form of expiresAt", () => {
  const dir = directory();
  // 2030-06-01T04:00:00+02:00 == 2030-06-01T02:00:00Z.
  const expiresAt = "2030-06-01T04:00:00+02:00";
  dir.tenants.acme!.users.alice = { role: "reader", enabled: true, tokens: [token("alice-1", "alice-token-1", expiresAt)] };
  assert.equal(resolveHostedAuth(dir, "alice-token-1", Date.parse("2030-06-01T02:00:00Z")), null);
  const valid = resolveHostedAuth(dir, "alice-token-1", Date.parse("2030-06-01T01:59:59Z"));
  assert.ok(valid !== null && valid.authType === "named_user");
});

test("a revoked token never authenticates, even long before expiry", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [token("alice-1", "alice-token-1", FUTURE, true)];
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

test("a disabled user never authenticates, even with a valid token", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.enabled = false;
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

test("a user with an empty token list never authenticates (revoke all)", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [];
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
  assert.equal(resolveHostedAuth(dir, "anything-else"), null);
});

test("a rejected named token NEVER falls back to legacy resolution", () => {
  // The same literal token value is ALSO acme's legacy client key: the named
  // record is expired, so it must be rejected — and must not authenticate as a
  // legacy key either. Fail closed, no fallback.
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [token("alice-1", "acme-client-key", PAST)];
  assert.notEqual(resolveTenant(dir.legacyKeys, "acme-client-key"), null);
  assert.equal(resolveHostedAuth(dir, "acme-client-key"), null);
});

// ---------------------------------------------------------------------------
// Defensive collision handling inside the resolver.
// ---------------------------------------------------------------------------

test("a digest matching two named tokens (hand-built) is ambiguous: null", () => {
  const dir = directory();
  // bob's token record reuses alice's token value.
  dir.tenants.acme!.users.bob.tokens = [token("bob-1", "alice-token-1")];
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

test("a digest matching two token records of ONE user (hand-built) is ambiguous: null", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [
    token("alice-1", "alice-token-1"),
    token("alice-2", "alice-token-1"),
  ];
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

test("a digest matching a named token AND a legacy key (hand-built) fails closed", () => {
  const dir = directory();
  // alice's token value equals the globex per-environment legacy key.
  dir.tenants.acme!.users.alice.tokens = [token("alice-1", "globex-prod-key")];
  assert.equal(resolveHostedAuth(dir, "globex-prod-key"), null);
});

test("the same collision fails closed even when the named record is revoked", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [token("alice-1", "acme-client-key", FUTURE, true)];
  assert.equal(resolveHostedAuth(dir, "acme-client-key"), null);
});

// ---------------------------------------------------------------------------
// Determinism and session stability.
// ---------------------------------------------------------------------------

test("resolution is deterministic regardless of record insertion order", () => {
  const dir = directory();
  const reordered: HostedAuthDirectory = {
    legacyKeys: Object.fromEntries(Object.entries(dir.legacyKeys).reverse()),
    tenants: Object.fromEntries(
      Object.entries(dir.tenants)
        .reverse()
        .map(([id, tenant]) => [
          id,
          {
            ...tenant,
            roles: Object.fromEntries(Object.entries(tenant.roles).reverse()),
            users: Object.fromEntries(Object.entries(tenant.users).reverse()),
          },
        ]),
    ),
    rawConfig: "{}",
  };
  assert.deepEqual(resolveHostedAuth(reordered, "alice-token-1"), resolveHostedAuth(dir, "alice-token-1"));
  assert.deepEqual(resolveHostedAuth(reordered, "acme-dev-key"), resolveHostedAuth(dir, "acme-dev-key"));
});

test("session identity survives rotation: a second token of the same user keeps authType/tenant/user", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [
    token("alice-1", "alice-token-1", FUTURE, true),
    token("alice-2", "alice-token-2"),
  ];
  const rotated = resolveHostedAuth(dir, "alice-token-2");
  assert.ok(rotated !== null && rotated.authType === "named_user");
  assert.equal(rotated.tenantId, "acme");
  assert.equal(rotated.userId, "alice");
  assert.equal(rotated.tokenId, "alice-2");
  // The revoked predecessor no longer authenticates at all.
  assert.equal(resolveHostedAuth(dir, "alice-token-1"), null);
});

// ---------------------------------------------------------------------------
// hasCredentialCollision: the loader's fail-closed collision gate.
// ---------------------------------------------------------------------------

test("a directory without duplicate hashes has no credential collision", () => {
  assert.equal(hasCredentialCollision(directory()), false);
});

test("the same token hash on two users of one tenant collides", () => {
  const dir = directory();
  dir.tenants.acme!.users.bob.tokens = [token("bob-1", "alice-token-1")];
  assert.equal(hasCredentialCollision(dir), true);
});

test("the same token hash on two tenants collides", () => {
  const dir = directory();
  dir.tenants.globex!.users.carol.tokens = [token("carol-1", "alice-token-1")];
  assert.equal(hasCredentialCollision(dir), true);
});

test("the same token hash twice within ONE user collides", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [
    token("alice-1", "alice-token-1"),
    token("alice-2", "alice-token-1"),
  ];
  assert.equal(hasCredentialCollision(dir), true);
});

test("a token hash equal to a legacy tenant apiKeyHash collides", () => {
  const dir = directory();
  dir.tenants.acme!.users.alice.tokens = [token("alice-1", "acme-client-key")];
  assert.equal(hasCredentialCollision(dir), true);
});

test("a token hash equal to a legacy per-environment key hash collides", () => {
  const dir = directory();
  dir.tenants.globex!.users.carol.tokens = [token("carol-1", "globex-prod-key")];
  assert.equal(hasCredentialCollision(dir), true);
});

test("legacy-vs-legacy duplicates alone are NOT a loader collision (resolveTenant owns them)", () => {
  const shared = digest("shared-legacy-key");
  const dir: HostedAuthDirectory = {
    legacyKeys: {
      acme: { apiKeyHash: shared, environments: {} },
      globex: { apiKeyHash: shared, environments: {} },
    },
    tenants: {},
    rawConfig: "{}",
  };
  assert.equal(hasCredentialCollision(dir), false);
});
