import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  parseCliArgs,
  buildConfigFromAnswers,
  writeConfigAtomic,
  backupExisting,
  runInit,
} from "../src/cli/init.js";

test("parseCliArgs: empty argv serves the MCP server", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "serve" });
});

test("parseCliArgs: 'init' selects the wizard", () => {
  assert.deepEqual(parseCliArgs(["init"]), { kind: "init" });
});

test("parseCliArgs: help forms are recognized", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["help"]), { kind: "help" });
});

test("parseCliArgs: an unknown subcommand is reported, never silently served", () => {
  assert.deepEqual(parseCliArgs(["frobnicate"]), { kind: "unknown", arg: "frobnicate" });
});

test("buildConfigFromAnswers: basic auth shape", () => {
  const cfg = buildConfigFromAnswers({
    authType: "basic",
    alias: "prod",
    baseUrl: "https://api2.successfactors.eu",
    username: "u",
    password: "p",
  }) as any;
  assert.deepEqual(cfg.environments.prod, {
    baseUrl: "https://api2.successfactors.eu",
    auth: { type: "basic", username: "u", password: "p" },
  });
  assert.equal(cfg.defaultEnvironment, null);
  assert.equal(cfg.entityAllowlist, undefined);
});

test("buildConfigFromAnswers: oauth auth with allowlist", () => {
  const cfg = buildConfigFromAnswers({
    authType: "oauth",
    alias: "prod",
    baseUrl: "https://api2.successfactors.eu",
    clientId: "c",
    companyId: "co",
    userId: "u",
    tokenUrl: "https://api2.successfactors.eu/oauth/token",
    privateKey: "KEY",
    allowlist: ["User", "PerPersonal"],
  }) as any;
  assert.equal(cfg.environments.prod.auth.type, "oauth");
  assert.equal(cfg.environments.prod.auth.userId, "u");
  assert.equal(cfg.environments.prod.auth.tokenUrl, "https://api2.successfactors.eu/oauth/token");
  assert.deepEqual(cfg.entityAllowlist, [{ entity: "User" }, { entity: "PerPersonal" }]);
});

test("writeConfigAtomic: writes exact contents, mode 0600, creates parent dirs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-init-"));
  const file = path.join(dir, "nested", "config.json");
  await writeConfigAtomic(file, '{"a":1}\n');
  assert.equal(await fs.readFile(file, "utf-8"), '{"a":1}\n');
  if (process.platform !== "win32") {
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test("backupExisting: copies to .bak when present, undefined when absent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-init-"));
  const file = path.join(dir, "config.json");
  assert.equal(await backupExisting(file), undefined);
  await fs.writeFile(file, "old", "utf-8");
  const bak = await backupExisting(file);
  assert.equal(bak, `${file}.bak`);
  assert.equal(await fs.readFile(`${file}.bak`, "utf-8"), "old");
});

test("runInit: a non-TTY environment exits with code 2 and writes nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-init-"));
  const file = path.join(dir, "config.json");
  const errors: string[] = [];
  const code = await runInit({ isTTY: false, configPath: file, stderr: (m) => errors.push(m) });
  assert.equal(code, 2);
  await assert.rejects(() => fs.stat(file));
  assert.ok(errors.length > 0, "expected an explanatory message on stderr");
});
