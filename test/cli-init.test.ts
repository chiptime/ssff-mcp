import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  parseCliArgs,
  buildConfigFromAnswers,
  allowlistFromSelection,
  selectAtLeastOne,
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
  assert.equal(cfg.environments.prod.entityAllowlist, undefined);
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
  assert.deepEqual(cfg.environments.prod.entityAllowlist, [{ entity: "User" }, { entity: "PerPersonal" }]);
});

test("allowlistFromSelection: never writes an empty allowlist, because [] means no narrowing", () => {
  // A real selection is written verbatim.
  assert.deepEqual(allowlistFromSelection(true, ["User", "PerPersonal"]), ["User", "PerPersonal"]);
  // `[]` narrows nothing, so writing it would invert a "restrict" answer.
  assert.equal(allowlistFromSelection(true, []), undefined);
  // Declining to restrict leaves the key absent, so the environment is unrestricted.
  assert.equal(allowlistFromSelection(false, undefined), undefined);
  assert.equal(allowlistFromSelection(false, ["User"]), undefined);
});

test("selectAtLeastOne: loops until the user picks at least one entity", async () => {
  const rounds: Array<string[] | undefined> = [[], ["User"]];
  let asked = 0;
  const chosen = await selectAtLeastOne({
    selectOnce: async () => rounds.shift(),
    askRetry: async () => {
      asked += 1;
      return true;
    },
  });
  assert.deepEqual(chosen, ["User"]);
  assert.equal(asked, 1);
});

test("selectAtLeastOne: stops when the user declines to retry", async () => {
  const chosen = await selectAtLeastOne({
    selectOnce: async () => [],
    askRetry: async () => false,
  });
  assert.equal(chosen, undefined);
});

test("selectAtLeastOne: a cancelled selection aborts without asking again", async () => {
  let asked = 0;
  const chosen = await selectAtLeastOne({
    selectOnce: async () => undefined,
    askRetry: async () => {
      asked += 1;
      return true;
    },
  });
  assert.equal(chosen, undefined);
  assert.equal(asked, 0);
});

test("an empty selection writes no allowlist at all, so the environment stays open", () => {
  const cfg = buildConfigFromAnswers({
    authType: "basic",
    alias: "prod",
    baseUrl: "https://api2.successfactors.eu",
    username: "u",
    password: "p",
    allowlist: allowlistFromSelection(true, []),
  }) as any;
  assert.equal("entityAllowlist" in cfg.environments.prod, false);
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
