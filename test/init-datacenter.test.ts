import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, buildConfigFromAnswers } from "../src/cli/init.js";
import { withTestServer, writeConfigFile, callTool } from "./helpers.js";

describe("CLI Flags and Init with Data Center (FR-112..FR-115, D-86..D-88)", () => {
  describe("parseCliArgs flags", () => {
    it("parses --datacenter flag", () => {
      const cmd = parseCliArgs(["--datacenter", "DC2"]);
      assert.equal(cmd.kind, "serve");
      if (cmd.kind === "serve") {
        assert.equal(cmd.datacenter, "DC2");
        assert.equal(cmd.inlineUrl, undefined);
      }
    });

    it("parses --dc flag", () => {
      const cmd = parseCliArgs(["--dc", "DC4"]);
      assert.equal(cmd.kind, "serve");
      if (cmd.kind === "serve") {
        assert.equal(cmd.datacenter, "DC4");
      }
    });

    it("parses -d flag", () => {
      const cmd = parseCliArgs(["-d", "DC55"]);
      assert.equal(cmd.kind, "serve");
      if (cmd.kind === "serve") {
        assert.equal(cmd.datacenter, "DC55");
      }
    });

    it("parses --inline-url flag", () => {
      const cmd = parseCliArgs(["--inline-url", "https://api2.successfactors.eu"]);
      assert.equal(cmd.kind, "serve");
      if (cmd.kind === "serve") {
        assert.equal(cmd.inlineUrl, "https://api2.successfactors.eu");
      }
    });

    it("parses both --dc and --inline-url flags", () => {
      const cmd = parseCliArgs(["--dc", "DC2", "--inline-url", "https://custom.gateway"]);
      assert.equal(cmd.kind, "serve");
      if (cmd.kind === "serve") {
        assert.equal(cmd.datacenter, "DC2");
        assert.equal(cmd.inlineUrl, "https://custom.gateway");
      }
    });

    it("rejects unknown flags", () => {
      const cmd = parseCliArgs(["--unknown-flag"]);
      assert.equal(cmd.kind, "unknown");
    });
  });

  describe("buildConfigFromAnswers with dataCenter", () => {
    it("includes dataCenter in the built environment object", () => {
      const config = buildConfigFromAnswers({
        alias: "prod",
        authType: "basic",
        baseUrl: "https://api2.successfactors.eu",
        dataCenter: "DC2",
        username: "user1",
        password: "secretpassword",
      });

      const envs = config.environments as Record<string, any>;
      assert.ok(envs.prod);
      assert.equal(envs.prod.baseUrl, "https://api2.successfactors.eu");
      assert.equal(envs.prod.dataCenter, "DC2");
    });
  });

  describe("list_environments reflects dataCenter (FR-115)", () => {
    it("reports dataCenter property in list_environments output when configured", async () => {
      const configJson = JSON.stringify({
        environments: {
          dc_env: {
            dataCenter: "DC2",
            auth: {
              type: "basic",
              username: "sfuser",
              password: "password123",
            },
          },
          plain_env: {
            baseUrl: "https://custom-gateway.corp",
            auth: {
              type: "basic",
              username: "sfuser",
              password: "password123",
            },
          },
        },
      });

      const configPath = await writeConfigFile(configJson);
      await withTestServer({ configPath }, async (client) => {
        const result = await callTool(client, "list_environments", {});
        assert.equal(result.isError, undefined);
        const envs = (
          result.structuredContent as {
            environments: Array<{ alias: string; authType: string; dataCenter?: string }>;
          }
        ).environments;

        const dcEnv = envs.find((e) => e.alias === "dc_env");
        assert.ok(dcEnv);
        assert.equal(dcEnv.dataCenter, "DC2");
        assert.equal(dcEnv.authType, "basic");

        const plainEnv = envs.find((e) => e.alias === "plain_env");
        assert.ok(plainEnv);
        assert.equal(plainEnv.dataCenter, undefined);
        assert.equal(plainEnv.authType, "basic");
      });
    });
  });
});
