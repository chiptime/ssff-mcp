import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { isEntityPermitted, type AllowlistEntry } from "../src/allowlist.js";
import { loadConfig } from "../src/config.js";

const allow = (entity: string, protocols?: Array<"v2" | "v4">): AllowlistEntry =>
  protocols === undefined ? { entity } : { entity, protocols };

async function configFile(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-denylist-"));
  const file = path.join(dir, "config.json");
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

const ENV = { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } };

// --- decision semantics (pure) --------------------------------------------------

test("the denylist wins over the allowlist for the same entity", () => {
  assert.equal(isEntityPermitted([allow("User")], [allow("User")], "User"), false);
});

test("an entity only in the denylist is denied while the rest stay reachable", () => {
  assert.equal(isEntityPermitted(undefined, [allow("Payroll")], "Payroll"), false);
  assert.equal(isEntityPermitted(undefined, [allow("Payroll")], "User"), true);
});

test("an empty denylist denies nothing", () => {
  assert.equal(isEntityPermitted(undefined, [], "User"), true);
  assert.equal(isEntityPermitted([allow("User")], [], "User"), true);
});

test("a denylist entry limited to v4 does not deny on v2", () => {
  assert.equal(isEntityPermitted(undefined, [allow("User", ["v4"])], "User"), true);
});

test("a denylist entry for v2 denies on v2", () => {
  assert.equal(isEntityPermitted(undefined, [allow("User", ["v2"])], "User"), false);
});

test("denylist matching is case-sensitive and exact", () => {
  assert.equal(isEntityPermitted(undefined, [allow("User")], "user"), true);
  assert.equal(isEntityPermitted(undefined, [allow("User")], "UserExtra"), true);
});

// --- config plumbing ------------------------------------------------------------

test("entityDenylist parses per environment and stays absent when not configured", async () => {
  const file = await configFile({
    environments: { prod: { ...ENV, entityDenylist: [{ entity: "Payroll" }] }, dev: ENV },
  });
  const config = await loadConfig({ configPath: file, env: {} });
  assert.deepEqual(config.environments.prod!.entityDenylist, [{ entity: "Payroll" }]);
  assert.equal("entityDenylist" in config.environments.dev!, false);
});

test("a duplicate entity in entityDenylist is rejected, naming the field", async () => {
  const file = await configFile({
    environments: { prod: { ...ENV, entityDenylist: [{ entity: "User" }, { entity: "User" }] } },
  });
  await assert.rejects(
    () => loadConfig({ configPath: file, env: {} }),
    (error: unknown) => {
      const message = (error as { message?: string }).message ?? "";
      assert.match(message, /entityDenylist/);
      assert.match(message, /duplicate/);
      return true;
    },
  );
});

test("an invalid entity name in entityDenylist is rejected, naming the field", async () => {
  const file = await configFile({
    environments: { prod: { ...ENV, entityDenylist: [{ entity: "User-X" }] } },
  });
  await assert.rejects(
    () => loadConfig({ configPath: file, env: {} }),
    (error: unknown) => {
      const message = (error as { message?: string }).message ?? "";
      assert.match(message, /entityDenylist/);
      return true;
    },
  );
});
