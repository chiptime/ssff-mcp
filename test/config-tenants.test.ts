/**
 * S1 (PRD-feature-multitenant-hosting.md, FR-157/D-119): the config accepts a
 * `tenants` level; the legacy flat shape auto-migrates to a single tenant.
 *
 * Resolution rules under test:
 * - flat shape  => single tenant "default" + one-time migration warning.
 * - tenants shape with exactly one tenant => that tenant resolves, no warning.
 * - tenants shape with more than one tenant => CONFIG_INVALID (stdio is
 *   single-tenant; multi-tenant is for `ssff-mcp serve`).
 * - entity lists: base at tenant level, per-environment override (REPLACE).
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "../src/config.js";
import { isSanitizedError, SanitizedError } from "../src/errors.js";

/** Assert the thrown value is a SanitizedError with the given code; return it for further checks. */
function expectSanitized(error: unknown, code: string): SanitizedError {
  if (!isSanitizedError(error)) {
    assert.fail(`expected SanitizedError with code ${code}, got: ${String(error)}`);
  }
  assert.equal(error.code, code);
  return error;
}

function rejectsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (error: unknown) => {
    expectSanitized(error, code);
    return true;
  });
}

async function writeConfigRaw(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-tenants-"));
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

const SHA = "a".repeat(64);

function basicEnv(baseUrl = "https://acme.example.com") {
  return { baseUrl, auth: { type: "basic" as const, username: "u", password: "p" } };
}

/** tenantId is a new field; cast keeps this file compiling before it exists (RED by assertion). */
function tenantIdOf(config: unknown): string | undefined {
  return (config as { tenantId?: string }).tenantId;
}

test("flat config auto-migrates to a single default tenant, warning once per process", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({ environments: { prod: basicEnv() }, defaultLocale: "es_ES" }),
  );
  const first: string[] = [];
  const config = await loadConfig({ configPath: filePath, onWarning: (m) => first.push(m) });
  assert.deepEqual(Object.keys(config.environments), ["prod"]);
  assert.equal(config.defaultLocale, "es_ES");
  assert.equal(tenantIdOf(config), "default");
  const migration = first.find((m) => m.includes("legacy"));
  assert.ok(migration, "expected a legacy-shape migration warning");
  assert.match(migration, /tenants/);

  // The warning is informative: once per process, not on every re-read.
  const second: string[] = [];
  await loadConfig({ configPath: filePath, onWarning: (m) => second.push(m) });
  assert.ok(!second.some((m) => m.includes("legacy")), "second load must not warn again");
});

test("tenants form resolves the single tenant without a migration warning", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      tenants: {
        acme: {
          apiKeyHash: SHA,
          environments: { dev: basicEnv(), prod: basicEnv("https://prod.example.com") },
        },
      },
    }),
  );
  const warnings: string[] = [];
  const config = await loadConfig({ configPath: filePath, onWarning: (m) => warnings.push(m) });
  assert.deepEqual(Object.keys(config.environments), ["dev", "prod"]);
  assert.equal(tenantIdOf(config), "acme");
  assert.ok(!warnings.some((m) => m.includes("legacy")));
});

test("entity lists: tenant base, per-environment override replaces (no merge)", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      tenants: {
        acme: {
          entityAllowlist: [{ entity: "User" }, { entity: "EmpJob" }],
          entityDenylist: [{ entity: "PerPersonal" }],
          environments: {
            dev: { ...basicEnv(), entityAllowlist: [{ entity: "User" }] },
            prod: basicEnv("https://prod.example.com"),
          },
        },
      },
    }),
  );
  const config = await loadConfig({ configPath: filePath });
  // dev overrides the allowlist entirely (EmpJob is NOT inherited) and, having
  // no denylist of its own, inherits the tenant-level one.
  assert.deepEqual(
    config.environments.dev?.entityAllowlist?.map((e) => e.entity),
    ["User"],
  );
  assert.deepEqual(
    config.environments.dev?.entityDenylist?.map((e) => e.entity),
    ["PerPersonal"],
  );
  // prod declares nothing: inherits both tenant-level lists.
  assert.deepEqual(
    config.environments.prod?.entityAllowlist?.map((e) => e.entity),
    ["User", "EmpJob"],
  );
  assert.deepEqual(
    config.environments.prod?.entityDenylist?.map((e) => e.entity),
    ["PerPersonal"],
  );
});

test("more than one tenant is rejected in stdio mode, pointing at serve", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      tenants: {
        acme: { environments: { prod: basicEnv() } },
        globex: { environments: { prod: basicEnv("https://globex.example.com") } },
      },
    }),
  );
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /serve/);
      return true;
    },
  );
});

test("tenants must declare at least one tenant", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({ tenants: {} }));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("flat environments and tenants together are an ambiguous shape and are rejected", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: { prod: basicEnv() },
      tenants: { acme: { environments: { prod: basicEnv() } } },
    }),
  );
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /environments|tenants|ambiguous/i);
      return true;
    },
  );
});

test("apiKeyHash must be a 64-char hex digest at tenant and environment level", async () => {
  const badTenant = await writeConfigRaw(
    JSON.stringify({ tenants: { acme: { apiKeyHash: "short", environments: { dev: basicEnv() } } } }),
  );
  await rejectsCode(() => loadConfig({ configPath: badTenant }), "CONFIG_INVALID");

  const badEnv = await writeConfigRaw(
    JSON.stringify({
      tenants: { acme: { environments: { dev: { ...basicEnv(), apiKeyHash: "nope" } } } },
    }),
  );
  await rejectsCode(() => loadConfig({ configPath: badEnv }), "CONFIG_INVALID");
});

test("unknown keys inside a tenant are rejected (strict)", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      tenants: { acme: { environments: { dev: basicEnv() }, entityAllowd: [] } },
    }),
  );
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("defaultLocale and maxResponseBytes keep working in the tenants form", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      tenants: { acme: { environments: { dev: basicEnv() } } },
      defaultLocale: "es_ES",
      maxResponseBytes: 131072,
    }),
  );
  const config = await loadConfig({ configPath: filePath });
  assert.equal(config.defaultLocale, "es_ES");
  assert.equal(config.maxResponseBytes, 131072);
});

test("inline mode synthesizes the default tenant id", async () => {
  const config = await loadConfig({
    configPath: path.join(os.tmpdir(), "ssff-mcp-tenants-missing.json"),
    env: {
      SF_BASE_URL: "https://inline.example.com",
      SF_USERNAME: "u",
      SF_PASSWORD: "p",
    },
  });
  assert.equal(config.inline, true);
  assert.equal(tenantIdOf(config), "default");
});
