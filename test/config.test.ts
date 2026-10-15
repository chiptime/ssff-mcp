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

test(
  "broader-than-owner file permissions produce a warning but not a failure",
  { skip: process.platform === "win32" ? "POSIX permission bits only" : false },
  async () => {
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

// --- Multi-platform permissions & Secret Providers (FR-41..FR-47) ------------

test("windows platform emits Windows ACL warning instead of chmod 600", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } },
      },
    }),
  );
  const warnings: string[] = [];
  await loadConfig({
    configPath: filePath,
    platform: "win32",
    statFile: async () => ({ mode: 0o666 }),
    onWarning: (msg) => warnings.push(msg),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /running on Windows; ensure access to .* is restricted using Windows ACLs/);
});

test("posix platform emits chmod 600 warning for loose permissions", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } },
      },
    }),
  );
  const warnings: string[] = [];
  await loadConfig({
    configPath: filePath,
    platform: "linux",
    statFile: async () => ({ mode: 0o644 }),
    onWarning: (msg) => warnings.push(msg),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recommend chmod 600/);
});

test("secret resolution via fromEnv succeeds when variable is present", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromEnv: "MY_SF_PASS" } },
        },
      },
    }),
  );
  const config = await loadConfig({
    configPath: filePath,
    secretOptions: { env: { MY_SF_PASS: "resolved-password-123" } },
  });
  const env = config.environments.prod;
  assert.equal(env.auth.type, "basic");
  if (env.auth.type === "basic") {
    assert.equal(env.auth.password, "resolved-password-123");
  }
});

test("secret resolution via fromEnv fails with CONFIG_SECRET_MISSING when unset or empty", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromEnv: "NON_EXISTENT_VAR" } },
        },
      },
    }),
  );
  await assert.rejects(
    () => loadConfig({ configPath: filePath, secretOptions: { env: {} } }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_SECRET_MISSING");
      assert.match(err.message, /NON_EXISTENT_VAR/);
      return true;
    },
  );
});

test("secret resolution via fromCommand succeeds and strips trailing newline", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromCommand: ["op", "read", "vault/item"] } },
        },
      },
    }),
  );
  const config = await loadConfig({
    configPath: filePath,
    secretOptions: {
      execCommand: async (file, args) => {
        assert.equal(file, "op");
        assert.deepEqual(args, ["read", "vault/item"]);
        return { stdout: "super-secret-from-cli\n" };
      },
    },
  });
  const env = config.environments.prod;
  assert.equal(env.auth.type, "basic");
  if (env.auth.type === "basic") {
    assert.equal(env.auth.password, "super-secret-from-cli");
  }
});

test("secret resolution via fromCommand fails on error or empty output", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromCommand: ["failing-cli"] } },
        },
      },
    }),
  );
  await assert.rejects(
    () =>
      loadConfig({
        configPath: filePath,
        secretOptions: {
          execCommand: async () => {
            throw new Error("Command failed with exit code 1");
          },
        },
      }),
    (error: unknown) => {
      expectSanitized(error, "CONFIG_SECRET_COMMAND_FAILED");
      return true;
    },
  );

  await assert.rejects(
    () =>
      loadConfig({
        configPath: filePath,
        secretOptions: {
          execCommand: async () => ({ stdout: "   \n" }),
        },
      }),
    (error: unknown) => {
      expectSanitized(error, "CONFIG_SECRET_COMMAND_FAILED");
      return true;
    },
  );
});

test("a resolved secret never leaks into warnings or error messages (FR-47)", async () => {
  const secret = "s3cr3t-from-cli-9f3a1c";
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromCommand: ["op", "read", "vault/item"] } },
        },
      },
    }),
  );

  // Success path: it resolves, and nothing emitted alongside it carries it.
  const warnings: string[] = [];
  const config = await loadConfig({
    configPath: filePath,
    onWarning: (m) => warnings.push(m),
    secretOptions: { execCommand: async () => ({ stdout: `${secret}\n` }) },
  });
  const env = config.environments.prod!;
  assert.equal(env.auth.type, "basic");
  if (env.auth.type === "basic") {
    assert.equal(env.auth.password, secret);
  }
  assert.equal(warnings.join("\n").includes(secret), false, "the secret leaked into a warning");

  // Failure path: a command that echoes the secret while failing must not leak it.
  await assert.rejects(
    () =>
      loadConfig({
        configPath: filePath,
        onWarning: (m) => warnings.push(m),
        secretOptions: {
          execCommand: async () => {
            throw new Error(`command failed: ${secret}`);
          },
        },
      }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_SECRET_COMMAND_FAILED");
      assert.equal(err.message.includes(secret), false, "the secret leaked into the error message");
      return true;
    },
  );
  assert.equal(warnings.join("\n").includes(secret), false, "the secret leaked into a warning");
});

test("fromCommand arguments reach execFile literally, with no shell interpretation", async () => {
  // Through a shell, `;` would split this and the second half would execute.
  // execFile({ shell: false }) passes the argument verbatim. Payload is harmless.
  const payload = "hello; echo pwned";
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: {
            type: "basic",
            username: "u",
            password: { fromCommand: ["node", "-e", "process.stdout.write(process.argv[1])", payload] },
          },
        },
      },
    }),
  );
  // No secretOptions: this really spawns the process.
  const config = await loadConfig({ configPath: filePath });
  const env = config.environments.prod!;
  assert.equal(env.auth.type, "basic");
  if (env.auth.type === "basic") {
    assert.equal(env.auth.password, payload);
  }
});

test("secret resolution via fromCommand fails with CONFIG_SECRET_TIMEOUT on timeout", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: { type: "basic", username: "u", password: { fromCommand: ["slow-cli"] } },
        },
      },
    }),
  );
  await assert.rejects(
    () =>
      loadConfig({
        configPath: filePath,
        secretOptions: {
          execCommand: async () => {
            const err = new Error("Command timed out");
            (err as unknown as { killed: boolean }).killed = true;
            throw err;
          },
        },
      }),
    (error: unknown) => {
      expectSanitized(error, "CONFIG_SECRET_TIMEOUT");
      return true;
    },
  );
});

test("oauth privateKey supports secret providers", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        oa: {
          baseUrl: "https://api2.successfactors.eu",
          auth: {
            type: "oauth",
            clientId: "cid",
            companyId: "cmp",
            userId: "uid",
            privateKey: { fromEnv: "SF_RSA_KEY" },
            tokenUrl: "https://api2.successfactors.eu/oauth/token",
          },
        },
      },
    }),
  );
  const config = await loadConfig({
    configPath: filePath,
    secretOptions: { env: { SF_RSA_KEY: "MIIEowIBAAKCAQEA..." } },
  });
  const env = config.environments.oa;
  assert.equal(env.auth.type, "oauth");
  if (env.auth.type === "oauth") {
    assert.equal(env.auth.privateKey, "MIIEowIBAAKCAQEA...");
  }
});

test("FR-47: secret resolution failures never echo secret values in errors or messages", async () => {
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: {
            type: "basic",
            username: "u",
            password: { fromCommand: ["echo", "secret-never-leaked"] },
          },
        },
      },
    }),
  );
  await assert.rejects(
    () =>
      loadConfig({
        configPath: filePath,
        secretOptions: {
          execCommand: async () => {
            throw new Error("Command failed: secret-never-leaked");
          },
        },
      }),
    (error: unknown) => {
      const err = expectSanitized(error, "CONFIG_SECRET_COMMAND_FAILED");
      assert.ok(!err.message.includes("secret-never-leaked"));
      return true;
    },
  );
});

test("fromCommand executes via execFile with shell: false and does not run shell metacharacters", async () => {
  // Pass shell metacharacters in an argument. With execFile (no shell),
  // they are passed literally as arguments rather than interpreted.
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://a.example.com",
          auth: {
            type: "basic",
            username: "u",
            password: { fromCommand: ["node", "-e", "process.stdout.write(process.argv[1]);", "hello;world"] },
          },
        },
      },
    }),
  );
  const config = await loadConfig({ configPath: filePath });
  const env = config.environments.prod;
  assert.equal(env.auth.type, "basic");
  if (env.auth.type === "basic") {
    assert.equal(env.auth.password, "hello;world");
  }
});

test("lazy secret resolution (D-42 / A3) resolves only requested environment", async () => {
  let prodExecCount = 0;
  let devExecCount = 0;
  const filePath = await writeConfigRaw(
    JSON.stringify({
      environments: {
        prod: {
          baseUrl: "https://prod.example.com",
          auth: { type: "basic", username: "u1", password: { fromCommand: ["get-prod-pass"] } },
        },
        dev: {
          baseUrl: "https://dev.example.com",
          auth: { type: "basic", username: "u2", password: { fromCommand: ["get-dev-pass"] } },
        },
      },
    }),
  );

  const secretOptions = {
    execCommand: async (file: string) => {
      if (file === "get-prod-pass") {
        prodExecCount++;
        return { stdout: "prod-secret\n" };
      }
      if (file === "get-dev-pass") {
        devExecCount++;
        return { stdout: "dev-secret\n" };
      }
      throw new Error("unexpected command");
    },
  };

  // 1. Resolve prod only
  const prodOnly = await loadConfig({
    configPath: filePath,
    resolveSecretsFor: "prod",
    secretOptions,
  });
  assert.equal(prodExecCount, 1);
  assert.equal(devExecCount, 0);
  assert.equal(prodOnly.environments.prod.auth.type === "basic" ? prodOnly.environments.prod.auth.password : "", "prod-secret");
  assert.equal(prodOnly.environments.dev.auth.type === "basic" ? prodOnly.environments.dev.auth.password : "", "");

  // 2. Resolve none (null)
  const none = await loadConfig({
    configPath: filePath,
    resolveSecretsFor: null,
    secretOptions,
  });
  assert.equal(prodExecCount, 1);
  assert.equal(devExecCount, 0);
  assert.equal(none.environments.prod.auth.type === "basic" ? none.environments.prod.auth.password : "", "");
  assert.equal(none.environments.dev.auth.type === "basic" ? none.environments.dev.auth.password : "", "");
});



// --- defaultLocale (FR-76, D-70) --------------------------------------------

function withDefaultLocale(value: unknown): string {
  return JSON.stringify({
    environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
    defaultLocale: value,
  });
}

test("defaultLocale accepts lax BCP-47 forms (es, es_ES, es-ES) and is preserved verbatim", async () => {
  for (const value of ["es", "es_ES", "es-ES", "en_US"]) {
    const config = await loadConfig({ configPath: await writeConfigRaw(withDefaultLocale(value)) });
    assert.equal(config.defaultLocale, value);
  }
});

test("defaultLocale absent leaves config.defaultLocale undefined (not an error)", async () => {
  const config = await loadConfig({
    configPath: await writeConfigRaw(
      JSON.stringify({
        environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
      }),
    ),
  });
  assert.equal(config.defaultLocale, undefined);
  assert.ok(!("defaultLocale" in config));
});

test("defaultLocale rejects malformed values with CONFIG_INVALID", async () => {
  for (const value of ["", "e", "english", "es_ESP", "es__ES", 5, null]) {
    await rejectsCode(
      () => loadConfig({ readFile: async () => withDefaultLocale(value) }),
      "CONFIG_INVALID",
    );
  }
});

test("unknown top-level keys are still rejected after adding defaultLocale (strict schema)", async () => {
  await rejectsCode(
    () =>
      loadConfig({
        readFile: async () =>
          JSON.stringify({
            environments: { a: { baseUrl: "https://a.example.com", auth: { type: "basic", username: "u", password: "p" } } },
            defaultLocal: "es_ES",
          }),
      }),
    "CONFIG_INVALID",
  );
});
