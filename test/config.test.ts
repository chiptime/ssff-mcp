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

test("unknown auth type is rejected", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "api-key", token: "x" } } },
  }));
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_INVALID");
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

function oauthEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: "https://tenant.example.com",
    auth: {
      type: "oauth",
      clientId: "api-key",
      companyId: "company",
      userId: "SFAPI",
      privateKey: "key-material",
      tokenUrl: "https://auth.example.com/oauth/token",
      ...overrides,
    },
  };
}

test("oauth auth parses and idpUrl is derived from the tokenUrl origin", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({ environments: { oa: oauthEnv() } }));
  const config = await loadConfig({ configPath: filePath });
  const auth = config.environments.oa!.auth;
  assert.equal(auth.type, "oauth");
  if (auth.type === "oauth") {
    assert.equal(auth.idpUrl, "https://auth.example.com/oauth/idp");
    assert.equal(auth.tokenUrl, "https://auth.example.com/oauth/token");
  }
});

test("an explicit idpUrl is honored", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: { oa: oauthEnv({ idpUrl: "https://idp.example.com/oauth/idp" }) },
    }),
  );
  const config = await loadConfig({ configPath: filePath });
  if (config.environments.oa!.auth.type === "oauth") {
    assert.equal(config.environments.oa!.auth.idpUrl, "https://idp.example.com/oauth/idp");
  }
});

test("http tokenUrl is rejected", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({ environments: { oa: oauthEnv({ tokenUrl: "http://auth.example.com/oauth/token" }) } }),
  );
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("oauth userId containing @ is rejected with a guiding message", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({ environments: { oa: oauthEnv({ userId: "SFAPI@company" }) } }),
  );
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      expectSanitized(error, "CONFIG_INVALID");
      assert.match((error as { message: string }).message, /WITHOUT the @companyId/);
      return true;
    },
  );
});

test("missing oauth fields are rejected", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({ environments: { oa: oauthEnv({ privateKey: undefined }) } }),
  );
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

// --- entityAllowlist (FR-28, D-30 with D-15 semantics) -------------------------

function withAllowlist(entries: unknown): string {
  return JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
    entityAllowlist: entries,
  });
}

test("a valid entityAllowlist parses with entries preserved", async () => {
  const filePath = await writeConfigRaw(
    withAllowlist([
      { entity: "User" },
      { entity: "JobRequisition", protocols: ["v2"] },
      { entity: "Foobar", protocols: ["v2", "v4"] },
    ]),
  );
  const config = await loadConfig({ configPath: filePath });
  assert.deepEqual(config.entityAllowlist, [
    { entity: "User" },
    { entity: "JobRequisition", protocols: ["v2"] },
    { entity: "Foobar", protocols: ["v2", "v4"] },
  ]);
});

test("entityAllowlist absent leaves config.entityAllowlist undefined", async () => {
  const filePath = await writeConfigRaw(JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
  }));
  const config = await loadConfig({ configPath: filePath });
  assert.equal("entityAllowlist" in config, false);
  assert.equal(config.entityAllowlist, undefined);
});

test("an empty entityAllowlist parses as a configured deny-all", async () => {
  const filePath = await writeConfigRaw(withAllowlist([]));
  const config = await loadConfig({ configPath: filePath });
  assert.deepEqual(config.entityAllowlist, []);
});

test("invalid entity names are rejected", async () => {
  for (const entity of ["", "9User", "User Peterson", "User-X", "User(X)"]) {
    const filePath = await writeConfigRaw(withAllowlist([{ entity }]));
    await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
  }
});

test("an empty protocols array is rejected", async () => {
  const filePath = await writeConfigRaw(withAllowlist([{ entity: "User", protocols: [] }]));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("duplicate protocols in one entry are rejected", async () => {
  const filePath = await writeConfigRaw(withAllowlist([{ entity: "User", protocols: ["v2", "v2"] }]));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("unknown protocols are rejected", async () => {
  const filePath = await writeConfigRaw(withAllowlist([{ entity: "User", protocols: ["v3"] }]));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});

test("duplicate entities are rejected as ambiguous", async () => {
  const filePath = await writeConfigRaw(
    withAllowlist([{ entity: "User" }, { entity: "JobRequisition" }, { entity: "User", protocols: ["v2"] }]),
  );
  await assert.rejects(
    () => loadConfig({ configPath: filePath }),
    (error: unknown) => {
      expectSanitized(error, "CONFIG_INVALID");
      assert.match((error as { message: string }).message, /duplicate/);
      return true;
    },
  );
});

test("unknown keys inside an allowlist entry are rejected", async () => {
  const filePath = await writeConfigRaw(withAllowlist([{ entity: "User", protocol: "v2" }]));
  await rejectsCode(() => loadConfig({ configPath: filePath }), "CONFIG_INVALID");
});
