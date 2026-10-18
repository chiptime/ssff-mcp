import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveTenant, sha256Hex, type TenantKeyDirectory } from "../src/tenancy.js";

const KEY_ACME = "acme-client-key";
const KEY_ACME_DEV = "acme-dev-only-key";
const KEY_GLOBEX = "globex-client-key";
const KEY_GLOBEX_PROD = "globex-prod-only-key";

const digest = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

function directory(): TenantKeyDirectory {
  return {
    acme: {
      apiKeyHash: digest(KEY_ACME),
      environments: {
        dev: digest(KEY_ACME_DEV),
        test: undefined,
        prod: undefined,
      },
    },
    globex: {
      apiKeyHash: digest(KEY_GLOBEX),
      environments: {
        prod: digest(KEY_GLOBEX_PROD),
      },
    },
  };
}

test("sha256Hex matches the known abc test vector", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a client-wide key reaches every environment of its tenant", () => {
  const resolution = resolveTenant(directory(), KEY_ACME);
  assert.deepEqual(resolution, { tenantId: "acme", allowedEnvironments: ["dev", "prod", "test"] });
});

test("an environment key reaches ONLY that environment", () => {
  const resolution = resolveTenant(directory(), KEY_ACME_DEV);
  assert.deepEqual(resolution, { tenantId: "acme", allowedEnvironments: ["dev"] });
});

test("the key of one tenant never grants the other tenant", () => {
  const resolution = resolveTenant(directory(), KEY_GLOBEX_PROD);
  assert.deepEqual(resolution, { tenantId: "globex", allowedEnvironments: ["prod"] });
  assert.equal(resolveTenant(directory(), KEY_GLOBEX)?.tenantId, "globex");
  // And cross-tenant: an acme key must never resolve globex.
  assert.equal(resolveTenant(directory(), KEY_ACME)?.tenantId, "acme");
});

test("absent, empty or whitespace keys are rejected (fail-closed)", () => {
  assert.equal(resolveTenant(directory(), undefined), null);
  assert.equal(resolveTenant(directory(), ""), null);
  assert.equal(resolveTenant(directory(), "   "), null);
});

test("an unknown key is rejected, never mapped to a default tenant", () => {
  assert.equal(resolveTenant(directory(), "no-such-key"), null);
  assert.equal(resolveTenant(directory(), `${KEY_ACME}x`), null);
  assert.equal(resolveTenant(directory(), KEY_ACME.toUpperCase()), null);
});

test("a tenant without any key is unreachable", () => {
  const dir: TenantKeyDirectory = {
    keyless: { environments: { prod: undefined } },
  };
  assert.equal(resolveTenant(dir, "anything"), null);
  assert.equal(resolveTenant(dir, ""), null);
});

test("the innermost level wins: an environment key beats the client-wide key", () => {
  const same = digest(KEY_ACME);
  const dir: TenantKeyDirectory = {
    acme: {
      apiKeyHash: same,
      environments: { dev: same, prod: undefined },
    },
  };
  // Same digest at both levels: the more specific (environment) scope applies.
  assert.deepEqual(resolveTenant(dir, KEY_ACME), { tenantId: "acme", allowedEnvironments: ["dev"] });
});

test("resolution is deterministic regardless of key insertion order", () => {
  const dir = directory();
  const reordered = Object.fromEntries(Object.entries(dir).reverse());
  assert.deepEqual(resolveTenant(reordered, KEY_ACME_DEV), {
    tenantId: "acme",
    allowedEnvironments: ["dev"],
  });
});
