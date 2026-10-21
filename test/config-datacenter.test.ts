import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type SsffConfig } from "../src/config.js";

function mockFs(files: Record<string, string>) {
  return async (filePath: string): Promise<string> => {
    if (filePath in files) {
      return files[filePath]!;
    }
    const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
}

describe("Data Center in Configuration (FR-109..FR-111, D-83..D-85)", () => {
  it("hydrates baseUrl from dataCenter when baseUrl is omitted", async () => {
    const configJson = JSON.stringify({
      environments: {
        prod: {
          dataCenter: "DC2",
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    const config = await loadConfig({
      configPath: "/mock/config.json",
      readFile: mockFs({ "/mock/config.json": configJson }),
    });

    assert.equal(config.environments.prod?.baseUrl, "https://api2.successfactors.eu");
    assert.equal(config.environments.prod?.dataCenter, "DC2");
    assert.equal(config.environments.prod?.auth.type, "basic");
  });

  it("hydrates baseUrl from case-insensitive dataCenter code (e.g. dc55)", async () => {
    const configJson = JSON.stringify({
      environments: {
        eu: {
          dataCenter: "dc55",
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    const config = await loadConfig({
      configPath: "/mock/config.json",
      readFile: mockFs({ "/mock/config.json": configJson }),
    });

    assert.equal(config.environments.eu?.baseUrl, "https://api55.sapsf.eu");
    assert.equal(config.environments.eu?.dataCenter, "DC55");
  });

  it("fails validation when dataCenter is unknown and baseUrl is omitted", async () => {
    const configJson = JSON.stringify({
      environments: {
        prod: {
          dataCenter: "DC999",
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    await assert.rejects(
      async () => {
        await loadConfig({
          configPath: "/mock/config.json",
          readFile: mockFs({ "/mock/config.json": configJson }),
        });
      },
      (err: any) => {
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /unknown dataCenter "DC999"/);
        assert.match(err.message, /supported data centers/);
        return true;
      }
    );
  });

  it("fails validation when neither baseUrl nor dataCenter is specified", async () => {
    const configJson = JSON.stringify({
      environments: {
        prod: {
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    await assert.rejects(
      async () => {
        await loadConfig({
          configPath: "/mock/config.json",
          readFile: mockFs({ "/mock/config.json": configJson }),
        });
      },
      (err: any) => {
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /at least "baseUrl" or "dataCenter"/);
        return true;
      }
    );
  });

  it("gives baseUrl absolute precedence over dataCenter and emits a warning when they differ", async () => {
    const warnings: string[] = [];
    const configJson = JSON.stringify({
      environments: {
        prod: {
          dataCenter: "DC2",
          baseUrl: "https://custom-gateway.internal.corp",
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    const config = await loadConfig({
      configPath: "/mock/config.json",
      readFile: mockFs({ "/mock/config.json": configJson }),
      onWarning: (msg) => warnings.push(msg),
    });

    assert.equal(config.environments.prod?.baseUrl, "https://custom-gateway.internal.corp");
    assert.equal(config.environments.prod?.dataCenter, "DC2");
    assert.ok(
      warnings.some(
        (w) =>
          w.includes("differs from dataCenter") &&
          w.includes("baseUrl takes precedence")
      ),
      `expected warning about differing baseUrl, got: ${JSON.stringify(warnings)}`
    );
  });

  it("does not warn when baseUrl matches the dataCenter canonical apiBaseUrl", async () => {
    const warnings: string[] = [];
    const configJson = JSON.stringify({
      environments: {
        prod: {
          dataCenter: "DC2",
          baseUrl: "https://api2.successfactors.eu",
          auth: {
            type: "basic",
            username: "sfuser",
            password: "secretpassword",
          },
        },
      },
    });

    const config = await loadConfig({
      configPath: "/mock/config.json",
      readFile: mockFs({ "/mock/config.json": configJson }),
      onWarning: (msg) => warnings.push(msg),
    });

    assert.equal(config.environments.prod?.baseUrl, "https://api2.successfactors.eu");
    assert.ok(!warnings.some((w) => w.includes("differs from dataCenter")));
  });

  it("automatically derives tokenUrl for OAuth 2.0 when omitted", async () => {
    const configJson = JSON.stringify({
      environments: {
        prod: {
          dataCenter: "DC4",
          auth: {
            type: "oauth",
            clientId: "myclient",
            companyId: "mycompany",
            userId: "techuser",
            privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
          },
        },
      },
    });

    const config = await loadConfig({
      configPath: "/mock/config.json",
      readFile: mockFs({ "/mock/config.json": configJson }),
    });

    const auth = config.environments.prod?.auth;
    assert.equal(auth?.type, "oauth");
    if (auth?.type === "oauth") {
      assert.equal(auth.tokenUrl, "https://api4.successfactors.com/oauth/token");
      assert.equal(auth.idpUrl, "https://api4.successfactors.com/oauth/idp");
    }
  });

  it("synthesizes inline configuration with SF_DATACENTER when SF_BASE_URL is omitted", async () => {
    const config = await loadConfig({
      configPath: "/nonexistent/config.json",
      env: {
        SF_DATACENTER: "DC12",
        SF_USERNAME: "testuser",
        SF_PASSWORD: "testpassword",
      },
    });

    assert.equal(config.inline, true);
    assert.equal(config.environments.default?.baseUrl, "https://api12.successfactors.eu");
    assert.equal(config.environments.default?.dataCenter, "DC12");
  });

  it("derives inline OAuth tokenUrl automatically when SF_TOKEN_URL is omitted", async () => {
    const config = await loadConfig({
      configPath: "/nonexistent/config.json",
      env: {
        SF_DATACENTER: "DC2",
        SF_CLIENT_ID: "client123",
        SF_COMPANY_ID: "company123",
        SF_USER_ID: "techadmin",
        SF_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      },
    });

    assert.equal(config.inline, true);
    assert.equal(config.environments.default?.baseUrl, "https://api2.successfactors.eu");
    const auth = config.environments.default?.auth;
    assert.equal(auth?.type, "oauth");
    if (auth?.type === "oauth") {
      assert.equal(auth.tokenUrl, "https://api2.successfactors.eu/oauth/token");
      assert.equal(auth.idpUrl, "https://api2.successfactors.eu/oauth/idp");
    }
  });
});
