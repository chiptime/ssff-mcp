/**
 * Hosted auth directory loading (S1–S3, S6 of odd/tasks/local-user-tokens.md):
 *
 * - `loadHostedAuthDirectory` reads ONE raw JSON snapshot, validates the new
 *   tenant-local `roles`/`users` keys and never resolves SSFF secrets.
 * - Every malformed local-auth shape is a sanitized CONFIG_INVALID (strict
 *   schemas; no issuer/subject/IAS fields; no credentials on users).
 * - Token hash duplicates — across users, tenants, or against legacy API keys —
 *   fail closed at load, even for expired/revoked records.
 * - `loadConfig` (STDIO) accepts the new keys but ignores local auth.
 * - Legacy behavior pins: `loadTenantKeyDirectory` projection and the old
 *   API-key scope through `resolveHostedAuth` stay unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  loadConfig,
  loadHostedAuthDirectory,
  loadTenantKeyDirectory,
} from "../src/config.js";
import { resolveHostedAuth, type HostedAuthDirectory } from "../src/local-auth.js";
import { sha256Hex } from "../src/tenancy.js";
import { isSanitizedError, SanitizedError } from "../src/errors.js";

/** Assert the thrown value is a SanitizedError with the given code; return it for further checks. */
function expectSanitized(error: unknown, code: string): SanitizedError {
  if (!isSanitizedError(error)) {
    assert.fail(`expected SanitizedError with code ${code}, got: ${String(error)}`);
  }
  assert.equal(error.code, code);
  return error;
}

/** Assert the call rejects with CONFIG_INVALID; return the error for message checks. */
async function rejectsInvalid(fn: () => Promise<unknown>): Promise<SanitizedError> {
  try {
    await fn();
  } catch (error) {
    return expectSanitized(error, "CONFIG_INVALID");
  }
  assert.fail("expected a CONFIG_INVALID SanitizedError, but the call resolved");
}

async function writeConfigRaw(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-local-auth-"));
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

const digest = (token: string): string => sha256Hex(token);
const FUTURE = "2049-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

function basicEnv(baseUrl = "https://acme.example.com") {
  return { baseUrl, auth: { type: "basic" as const, username: "u", password: "p" } };
}

/** Loose JSON-shape types so tests can mutate fixtures (extra fields are the point). */
interface FixtureToken {
  id: string;
  hash: string;
  expiresAt: string;
  revoked?: boolean;
  [extra: string]: unknown;
}
interface FixtureUser {
  role: string;
  enabled?: boolean;
  tokens: FixtureToken[];
  [extra: string]: unknown;
}
interface FixtureRole {
  environments: string[];
  entityAllowlist?: { entity: string }[];
  entityDenylist?: { entity: string }[];
  [extra: string]: unknown;
}
interface FixtureEnv {
  baseUrl: string;
  auth: { type: "basic"; username: string; password: string | { fromEnv: string } };
  apiKeyHash?: string;
}
interface FixtureTenant {
  apiKeyHash?: string;
  environments: Record<string, FixtureEnv>;
  roles: Record<string, FixtureRole>;
  users: Record<string, FixtureUser>;
}

function userToken(id: string, tokenValue: string, overrides: Record<string, unknown> = {}): FixtureToken {
  return { id, hash: digest(tokenValue), expiresAt: FUTURE, ...overrides };
}

/** The canonical local-auth tenant JSON used by the happy-path tests. */
function localAuthTenantsJson(): Record<string, FixtureTenant> {
  return {
    acme: {
      apiKeyHash: digest("acme-client-key"),
      environments: { dev: basicEnv(), prod: basicEnv("https://prod.example.com") },
      roles: {
        reader: { environments: ["dev", "prod"] },
        "prod-only": {
          environments: ["prod"],
          entityDenylist: [{ entity: "PerPersonal" }],
        },
      },
      users: {
        alice: { role: "reader", tokens: [userToken("alice-1", "alice-token-1")] },
        bob: { role: "prod-only", enabled: false, tokens: [] },
      },
    },
    globex: {
      environments: { prod: basicEnv("https://globex.example.com") },
      roles: { reader: { environments: ["prod"], entityAllowlist: [{ entity: "User" }] } },
      users: {},
    },
  };
}

function hostedConfig(tenants: unknown): string {
  return JSON.stringify({ tenants });
}

// ---------------------------------------------------------------------------
// Happy path: projection and defaults.
// ---------------------------------------------------------------------------

test("loadHostedAuthDirectory returns legacy keys, local tenants and the raw snapshot", async () => {
  const raw = hostedConfig(localAuthTenantsJson());
  const filePath = await writeConfigRaw(raw);
  const directory = await loadHostedAuthDirectory({ configPath: filePath });

  // Legacy slice identical to loadTenantKeyDirectory on the same file.
  const legacy = await loadTenantKeyDirectory({ configPath: filePath });
  assert.deepEqual(directory.legacyKeys, legacy);

  // Local slice projected with defaults applied.
  const acme = directory.tenants.acme!;
  assert.deepEqual(acme.environments, ["dev", "prod"]);
  assert.deepEqual(acme.roles["prod-only"]!.entityDenylist, [{ entity: "PerPersonal" }]);
  const alice = acme.users.alice!;
  assert.equal(alice.role, "reader");
  assert.equal(alice.enabled, true, "enabled defaults to true");
  assert.deepEqual(alice.tokens, [
    { id: "alice-1", hash: digest("alice-token-1"), expiresAt: FUTURE, revoked: false },
  ]);
  const bob = acme.users.bob!;
  assert.equal(bob.enabled, false, "explicit enabled:false survives");
  assert.deepEqual(bob.tokens, [], "tokens: [] loads (revoke all)");

  // Empty users on globex: roles may exist with no principal.
  assert.deepEqual(Object.keys(directory.tenants.globex!.users), []);
  assert.ok(Object.keys(directory.tenants.globex!.roles).length > 0);

  assert.equal(directory.rawConfig, raw);
});

test("tenants without roles/users keep the old shape: empty local slices", async () => {
  const tenants = {
    acme: { apiKeyHash: digest("acme-client-key"), environments: { prod: basicEnv() } },
  };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  const directory = await loadHostedAuthDirectory({ configPath: filePath });
  assert.deepEqual(directory.legacyKeys, {
    acme: { apiKeyHash: digest("acme-client-key"), environments: { prod: undefined } },
  });
  assert.deepEqual(directory.tenants.acme!.roles, {});
  assert.deepEqual(directory.tenants.acme!.users, {});
  assert.deepEqual(directory.tenants.acme!.environments, ["prod"]);
});

test("expired token dates are VALID config: they load and simply never authenticate", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.users = { alice: { role: "reader", tokens: [userToken("alice-1", "alice-token-1", { expiresAt: PAST })] } };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  const directory = await loadHostedAuthDirectory({ configPath: filePath });
  assert.equal(directory.tenants.acme!.users.alice!.tokens[0]!.expiresAt, PAST);
  assert.equal(resolveHostedAuth(directory, "alice-token-1"), null);
});

test("expiresAt accepts timezone offsets, not only Z", async () => {
  const tenants = localAuthTenantsJson();
  const offsetForm = "2049-06-01T04:00:00+02:00";
  tenants.acme.users = { alice: { role: "reader", tokens: [userToken("alice-1", "alice-token-1", { expiresAt: offsetForm })] } };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  const directory = await loadHostedAuthDirectory({ configPath: filePath });
  assert.equal(directory.tenants.acme!.users.alice!.tokens[0]!.expiresAt, offsetForm);
});

// ---------------------------------------------------------------------------
// Validation: every malformed local-auth shape is a sanitized CONFIG_INVALID.
// ---------------------------------------------------------------------------

async function rejectsTenantsInvalid(mutate: (tenants: Record<string, FixtureTenant>) => void): Promise<SanitizedError> {
  const tenants = localAuthTenantsJson();
  mutate(tenants);
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  return await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: filePath }));
}

test("role environments must be a non-empty array", async () => {
  const error = await rejectsTenantsInvalid((t) => {
    t.acme.roles = { reader: { environments: [] } };
  });
  assert.match(error.message, /roles\.reader\.environments/i);
});

test("role environments must not contain duplicates", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.roles = { reader: { environments: ["prod", "prod"] } };
  });
});

test("role environments must be aliases the tenant declares", async () => {
  const error = await rejectsTenantsInvalid((t) => {
    t.acme.roles = { reader: { environments: ["staging"] } };
  });
  assert.match(error.message, /roles\.reader\.environments/i);
});

test("user role must reference a declared role", async () => {
  const error = await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "ghost", tokens: [] } };
  });
  assert.match(error.message, /users\.alice\.role/i);
});

test("users referencing roles when none are declared are invalid", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.roles = {};
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: filePath }));
});

test("token hash must be a lowercase sha-256 hex digest", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [userToken("a", "x", { hash: digest("x").toUpperCase() })] } };
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [userToken("a", "x", { hash: "abc" })] } };
  });
});

test("token expiresAt is required with a timezone (naive or date-only rejected)", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [{ id: "a", hash: digest("x") } as FixtureToken] } };
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [userToken("a", "x", { expiresAt: "2049-01-01T00:00:00" })] } };
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [userToken("a", "x", { expiresAt: "2049-01-01" })] } };
  });
});

test("token ids must be unique within a user", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = {
      alice: { role: "reader", tokens: [userToken("t-1", "x"), userToken("t-1", "y")] },
    };
  });
});

test("tokens are required on every user (empty is the revoke-all form)", async () => {
  const error = await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader" } as FixtureUser };
  });
  assert.match(error.message, /users\.alice/i);
});

test("user ids and role names must be non-empty", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.users = { "": { role: "reader", tokens: [] } };
  const emptyUserPath = await writeConfigRaw(hostedConfig(tenants));
  await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: emptyUserPath }));

  const tenants2 = localAuthTenantsJson();
  tenants2.acme.roles = { "": { environments: ["prod"] } };
  const emptyRolePath = await writeConfigRaw(hostedConfig(tenants2));
  await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: emptyRolePath }));
});

test("role/user/token records are strict: no issuer, subject or IAS-like fields", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users.alice.issuer = "https://ias.example.com";
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users.alice.tokens[0]!.subject = "alice@acme";
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.roles.reader.name = "Reader";
  });
});

test("users carry NO SSFF credentials: auth/password fields are rejected", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users.alice.auth = basicEnv().auth;
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users.alice.password = "p";
  });
});

test("flat (legacy) config fails exactly like loadTenantKeyDirectory", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({ environments: { prod: basicEnv() } }));
  const hostedError = await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: filePath }));
  const legacyError = await rejectsInvalid(() => loadTenantKeyDirectory({ configPath: filePath }));
  assert.equal(hostedError.message, legacyError.message);
  assert.match(hostedError.message, /has no "tenants" level/);
});

test("unreadable or non-JSON files are sanitized CONFIG_INVALID", async () => {
  const error = await rejectsInvalid(() =>
    loadHostedAuthDirectory({ configPath: "/nonexistent/ssff-mcp/config.json" }),
  );
  assert.match(error.message, /could not be read/);
  const badJson = await writeConfigRaw("{not json");
  await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: badJson }));
});

// ---------------------------------------------------------------------------
// Fail-closed collisions at load time.
// ---------------------------------------------------------------------------

test("the same token hash on two users of one tenant is CONFIG_INVALID", async () => {
  const error = await rejectsTenantsInvalid((t) => {
    t.acme.users = {
      alice: { role: "reader", tokens: [userToken("a-1", "shared-token")] },
      bob: { role: "prod-only", tokens: [userToken("b-1", "shared-token")] },
    };
  });
  assert.match(error.message, /hash/i);
  // The message must not leak the hash (or any 64-hex digest) itself.
  assert.ok(!error.message.includes(digest("shared-token")));
});

test("the same token hash on two tenants is CONFIG_INVALID", async () => {
  await rejectsTenantsInvalid((t) => {
    t.globex.users = { carol: { role: "reader", tokens: [userToken("c-1", "alice-token-1")] } };
  });
});

test("the same token hash twice within one user is CONFIG_INVALID", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = {
      alice: { role: "reader", tokens: [userToken("a-1", "alice-token-1"), userToken("a-2", "alice-token-1")] },
    };
  });
});

test("a token hash equal to a legacy tenant apiKeyHash is CONFIG_INVALID", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = { alice: { role: "reader", tokens: [userToken("a-1", "acme-client-key")] } };
  });
});

test("a token hash equal to a legacy per-environment key hash is CONFIG_INVALID", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.environments.dev = { ...basicEnv(), apiKeyHash: digest("acme-dev-key") };
  tenants.acme.users = { alice: { role: "reader", tokens: [userToken("a-1", "acme-dev-key")] } };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  await rejectsInvalid(() => loadHostedAuthDirectory({ configPath: filePath }));
});

test("collisions fail closed even when the records are expired or revoked", async () => {
  await rejectsTenantsInvalid((t) => {
    t.acme.users = {
      alice: { role: "reader", tokens: [userToken("a-1", "acme-client-key", { expiresAt: PAST })] },
    };
  });
  await rejectsTenantsInvalid((t) => {
    t.acme.users = {
      alice: { role: "reader", tokens: [userToken("a-1", "shared")] },
      bob: { role: "prod-only", tokens: [userToken("b-1", "shared", { revoked: true })] },
    };
  });
});

// ---------------------------------------------------------------------------
// Secrets isolation: the loader reads shape only, never resolves credentials.
// ---------------------------------------------------------------------------

test("loadHostedAuthDirectory never resolves SSFF secrets (fromEnv provider loads unset)", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.environments.prod = {
    baseUrl: "https://prod.example.com",
    auth: { type: "basic", username: "u", password: { fromEnv: "SSFF_LOCAL_AUTH_UNUSED_SECRET" } },
  };
  const singleTenant = hostedConfig({ acme: tenants.acme });
  const filePath = await writeConfigRaw(singleTenant);
  // No network, no process.env reads: the loader only validates shape.
  const directory = await loadHostedAuthDirectory({ configPath: filePath });
  assert.ok(Object.keys(directory.tenants).length > 0);
  // loadConfig WOULD resolve the secret and fail — pin that difference.
  await assert.rejects(
    loadConfig({ configPath: filePath, resolveSecretsFor: "prod" }),
    (error: unknown) => isSanitizedError(error) && error.code === "CONFIG_SECRET_MISSING",
  );
});

// ---------------------------------------------------------------------------
// STDIO: loadConfig accepts the new keys but ignores local auth.
// ---------------------------------------------------------------------------

test("loadConfig accepts tenants with roles/users and ignores local auth in STDIO", async () => {
  // STDIO resolves exactly ONE tenant: use a single-tenant slice of the fixture.
  const tenants = localAuthTenantsJson();
  const filePath = await writeConfigRaw(hostedConfig({ acme: tenants.acme }));
  const config = await loadConfig({ configPath: filePath });
  assert.equal(config.tenantId, "acme");
  assert.deepEqual(Object.keys(config.environments), ["dev", "prod"]);
  assert.equal(config.environments.prod?.auth.type, "basic");
  // The resolved STDIO config carries no local-auth projection at all.
  assert.equal("roles" in config, false);
  assert.equal("users" in config, false);
});

test("loadConfig still validates local auth shape strictly (malformed keys fail)", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.roles = { reader: { environments: ["staging"] } };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  await rejectsInvalid(() => loadConfig({ configPath: filePath }));
});

// ---------------------------------------------------------------------------
// Legacy pins (PRESERVE): pre-existing behavior holds after the change.
// ---------------------------------------------------------------------------

test("loadTenantKeyDirectory on an old tenants file is unchanged", async () => {
  const filePath = await writeConfigRaw(
    hostedConfig({
      acme: {
        apiKeyHash: digest("acme-client-key"),
        environments: {
          dev: { ...basicEnv(), apiKeyHash: digest("acme-dev-key") },
          prod: basicEnv("https://prod.example.com"),
        },
      },
    }),
  );
  const directory = await loadTenantKeyDirectory({ configPath: filePath });
  assert.deepEqual(directory, {
    acme: {
      apiKeyHash: digest("acme-client-key"),
      environments: { dev: digest("acme-dev-key"), prod: undefined },
    },
  });
});

test("loadTenantKeyDirectory accepts (and ignores) the local auth keys", async () => {
  const filePath = await writeConfigRaw(hostedConfig(localAuthTenantsJson()));
  const directory = await loadTenantKeyDirectory({ configPath: filePath });
  assert.deepEqual(directory, {
    acme: {
      apiKeyHash: digest("acme-client-key"),
      environments: { dev: undefined, prod: undefined },
    },
    globex: { environments: { prod: undefined } },
  });
});

test("old API-key scope: resolveHostedAuth matches resolveTenant on a loaded directory", async () => {
  const tenants = localAuthTenantsJson();
  tenants.acme.environments.dev = { ...basicEnv(), apiKeyHash: digest("acme-dev-key") };
  const filePath = await writeConfigRaw(hostedConfig(tenants));
  const directory: HostedAuthDirectory = await loadHostedAuthDirectory({ configPath: filePath });

  const legacy = resolveHostedAuth(directory, "acme-dev-key");
  assert.ok(legacy !== null && legacy.authType === "legacy_key");
  assert.equal(legacy.tenantId, "acme");
  assert.deepEqual(legacy.allowedEnvironments, ["dev"]);

  const clientWide = resolveHostedAuth(directory, "acme-client-key");
  assert.ok(clientWide !== null && clientWide.authType === "legacy_key");
  assert.deepEqual(clientWide.allowedEnvironments, ["dev", "prod"]);

  // And the named key of the same file keeps resolving as a named user.
  const named = resolveHostedAuth(directory, "alice-token-1");
  assert.ok(named !== null && named.authType === "named_user");
  assert.equal(named.userId, "alice");
});
