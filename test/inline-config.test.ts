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

/** Run `fn` with the given SF_* process env vars set (undefined deletes), restoring afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(vars);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key]!;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key]!;
      }
    }
  }
}

/** A path that is guaranteed not to exist, so loadConfig falls through to inline mode. */
function missingPath(): string {
  return path.join(os.tmpdir(), `ssff-mcp-inline-missing-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

async function writeTempConfig(contents: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), `ssff-mcp-inline-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(filePath, contents, "utf-8");
  return filePath;
}

const ALL_SF_KEYS = [
  "SF_BASE_URL",
  "SF_USERNAME",
  "SF_PASSWORD",
  "SF_ENVIRONMENT",
  "SF_ENTITY_ALLOWLIST",
  "SF_CLIENT_ID",
  "SF_COMPANY_ID",
  "SF_USER_ID",
  "SF_TOKEN_URL",
  "SF_IDP_URL",
  "SF_PRIVATE_KEY",
];

/** Clear every SF_* var so a test starts from a known-empty inline surface. */
function clearedEnv(): Record<string, undefined> {
  const vars: Record<string, undefined> = {};
  for (const key of ALL_SF_KEYS) {
    vars[key] = undefined;
  }
  return vars;
}

test("inline: env vars synthesize one 'default' environment when config.json is missing", async () => {
  await withEnv(
    { ...clearedEnv(), SF_BASE_URL: "https://api2.successfactors.eu", SF_USERNAME: "u", SF_PASSWORD: "p" },
    async () => {
      const config = await loadConfig({ configPath: missingPath() });
      assert.deepEqual(Object.keys(config.environments), ["default"]);
      assert.equal(config.environments.default!.baseUrl, "https://api2.successfactors.eu");
      assert.deepEqual(config.environments.default!.auth, { type: "basic", username: "u", password: "p" });
      assert.equal(config.environments.default!.entityAllowlist, undefined);
    },
  );
});

test("inline: SF_ENVIRONMENT names the synthesized alias", async () => {
  await withEnv(
    { ...clearedEnv(), SF_BASE_URL: "https://api2.successfactors.eu", SF_USERNAME: "u", SF_PASSWORD: "p", SF_ENVIRONMENT: "prod" },
    async () => {
      const config = await loadConfig({ configPath: missingPath() });
      assert.deepEqual(Object.keys(config.environments), ["prod"]);
    },
  );
});

test("inline: SF_BASE_URL without credentials still yields CONFIG_MISSING", async () => {
  await withEnv({ ...clearedEnv(), SF_BASE_URL: "https://api2.successfactors.eu" }, async () => {
    await assert.rejects(
      () => loadConfig({ configPath: missingPath() }),
      (error: unknown) => {
        expectSanitized(error, "CONFIG_MISSING");
        return true;
      },
    );
  });
});

test("inline: an existing but invalid config.json is not masked by inline env vars", async () => {
  await withEnv(
    { ...clearedEnv(), SF_BASE_URL: "https://api2.successfactors.eu", SF_USERNAME: "u", SF_PASSWORD: "p" },
    async () => {
      const filePath = await writeTempConfig("{ not json ]");
      await assert.rejects(
        () => loadConfig({ configPath: filePath }),
        (error: unknown) => {
          expectSanitized(error, "CONFIG_INVALID");
          return true;
        },
      );
    },
  );
});

test("inline: a valid config.json wins over inline vars and warns that inline is ignored", async () => {
  await withEnv(
    { ...clearedEnv(), SF_BASE_URL: "https://inline.example.com", SF_USERNAME: "u", SF_PASSWORD: "p" },
    async () => {
      const filePath = await writeTempConfig(
        JSON.stringify({
          environments: { file: { baseUrl: "https://file.example.com", auth: { type: "basic", username: "fu", password: "fp" } } },
        }),
      );
      const warnings: string[] = [];
      const config = await loadConfig({ configPath: filePath, onWarning: (m) => warnings.push(m) });
      assert.deepEqual(Object.keys(config.environments), ["file"]);
      assert.ok(
        warnings.some((m) => /inline/i.test(m)),
        `expected an inline-ignored warning, got: ${JSON.stringify(warnings)}`,
      );
    },
  );
});

test("inline: SF_ENTITY_ALLOWLIST maps to entityAllowlist (trim, drop empties)", async () => {
  await withEnv(
    {
      ...clearedEnv(),
      SF_BASE_URL: "https://api2.successfactors.eu",
      SF_USERNAME: "u",
      SF_PASSWORD: "p",
      SF_ENTITY_ALLOWLIST: "User, PerPersonal ,,EmpJob",
    },
    async () => {
      const config = await loadConfig({ configPath: missingPath() });
      assert.deepEqual(config.environments.default!.entityAllowlist, [
        { entity: "User" },
        { entity: "PerPersonal" },
        { entity: "EmpJob" },
      ]);
    },
  );
});

test("inline: duplicate entities in SF_ENTITY_ALLOWLIST are rejected with CONFIG_INVALID", async () => {
  await withEnv(
    {
      ...clearedEnv(),
      SF_BASE_URL: "https://api2.successfactors.eu",
      SF_USERNAME: "u",
      SF_PASSWORD: "p",
      SF_ENTITY_ALLOWLIST: "User,User",
    },
    async () => {
      await assert.rejects(
        () => loadConfig({ configPath: missingPath() }),
        (error: unknown) => {
          expectSanitized(error, "CONFIG_INVALID");
          return true;
        },
      );
    },
  );
});

test("inline: OAuth env vars synthesize an oauth environment", async () => {
  await withEnv(
    {
      ...clearedEnv(),
      SF_BASE_URL: "https://api2.successfactors.eu",
      SF_CLIENT_ID: "client",
      SF_COMPANY_ID: "company",
      SF_USER_ID: "techuser",
      SF_TOKEN_URL: "https://api2.successfactors.eu/oauth/token",
      SF_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----",
    },
    async () => {
      const config = await loadConfig({ configPath: missingPath() });
      const auth = config.environments.default!.auth;
      assert.equal(auth.type, "oauth");
      if (auth.type === "oauth") {
        assert.equal(auth.clientId, "client");
        assert.equal(auth.companyId, "company");
        assert.equal(auth.userId, "techuser");
        assert.equal(auth.tokenUrl, "https://api2.successfactors.eu/oauth/token");
        assert.equal(auth.idpUrl, "https://api2.successfactors.eu/oauth/idp");
        assert.ok(auth.privateKey.includes("BEGIN PRIVATE KEY"));
      }
    },
  );
});
