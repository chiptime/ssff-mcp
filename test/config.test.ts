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

/** assert.rejects shortcut: SanitizedError with the given code. */
function rejectsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (error: unknown) => {
    expectSanitized(error, code);
    return true;
  });
}

test("missing config file yields CONFIG_MISSING naming the tilde path and template, never $HOME", async () => {
  const missingPath = path.join(os.tmpdir(), "ssff-mcp-definitely-missing-config.json");
  await assert.rejects(
    () => loadConfig({ configPath: missingPath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_MISSING");
      assert.match(err.message, /~\/\.config\/ssff-mcp\/config\.json/);
      assert.match(err.message, /config\.template\.json/);
      // Must not leak the resolved absolute path ($HOME).
      assert.ok(!err.message.includes(os.homedir()));
      return true;
    },
  );
});

test("malformed JSON yields CONFIG_INVALID", async () => {
  const filePath = await writeConfigRaw("{ not json ]");
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("non-null defaultEnvironment is rejected (implicit selection forbidden)", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { prod: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
    defaultEnvironment: "prod",
  }));
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /defaultEnvironment/);
      return true;
    },
  );
});

test("null defaultEnvironment is accepted", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: {},
    defaultEnvironment: null,
  }));
  const config = await loadConfig({ configPath: filePath });
  assert.deepEqual(Object.keys(config.environments), []);
});

test("http baseUrl is rejected", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "http://api4.successfactors.com", auth: { type: "basic", username: "u", password: "p" } } },
  }));
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /https/);
      return true;
    },
  );
});

test("baseUrl with query string is rejected", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com/?x=1", auth: { type: "basic", username: "u", password: "p" } } },
  }));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("baseUrl with userinfo is rejected", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://user:pass@a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
  }));
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /userinfo|credentials/);
      return true;
    },
  );
});

test("non-basic auth type is rejected in the MVP", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "oauth", username: "u", password: "p" } } },
  }));
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
      assert.match(err.message, /basic/);
      return true;
    },
  );
});

test("unknown keys anywhere are rejected (typo protection)", async () => {
  const typoPath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseurl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
  }));
  await rejectsCode(() => loadConfig({ configPath: typoPath }), "CONFIG_INVALID");

  const topLevelPath = await writeConfigRaw(JSON.stringify({
    environments: {},
    extra: true,
  }));
  await rejectsCode(() => loadConfig({ configPath: topLevelPath }), "CONFIG_INVALID");

  const authExtraPath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p", token: "x" } } },
  }));
  await rejectsCode(() => loadConfig({ configPath: authExtraPath }), "CONFIG_INVALID");
});

test("valid multi-environment config parses with normalized baseUrls", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: {
      prod: {
        baseUrl: "https://api4.successfactors.com/",
        auth: { type: "basic", username: "user@company", password: "p1" },
      },
      staging: {
        baseUrl: "https://staging.example.com/prefix/",
        auth: { type: "basic", username: "svc@company", password: "p2" },
      },
    },
  }));
  const config = await loadConfig({ configPath: filePath });
  assert.deepEqual(Object.keys(config.environments).sort(), ["prod", "staging"]);
  assert.equal(config.environments.prod!.baseUrl, "https://api4.successfactors.com");
  assert.equal(config.environments.staging!.baseUrl, "https://staging.example.com/prefix");
  assert.equal(config.environments.prod!.auth.type, "basic");
  assert.equal(config.environments.prod!.auth.username, "user@company");
});

test("broader-than-owner file permissions produce a warning but not a failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-perm-"));
  const filePath = path.join(dir, "config.json");
  const contents = JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
  });
  await fs.writeFile(filePath, contents, "utf-8");
  await fs.chmod(filePath, 0o644);

  const warnings: string[] = [];
  const config = await loadConfig({ configPath: filePath, onWarning: (m) => warnings.push(m) });
  assert.ok(config.environments.a !== undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /chmod 600/);
  assert.ok(!warnings[0]!.includes(os.homedir()));
});

async function writeConfigRaw(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssff-mcp-cfg-"));
  const filePath = path.join(dir, "config.json");
  await fs.writeFile(filePath, contents, "utf-8");
  await fs.chmod(filePath, 0o600);
  return filePath;
}
