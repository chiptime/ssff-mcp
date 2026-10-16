import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../src/version.js";
import { USER_AGENT } from "../src/http.js";
import { configJson, withTestServer, writeConfigFile } from "./helpers.js";

/**
 * The version must have exactly one source of truth: the `package.json` that
 * ships with the package. Hardcoded copies drift, and this repository had
 * already shipped two of them (the outgoing User-Agent and the MCP server
 * handshake) stuck at an old release.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8"),
) as { version: string };

test("the runtime version tracks package.json (single source of truth)", () => {
  assert.equal(PACKAGE_VERSION, manifest.version);
});

test("the outgoing User-Agent carries the package version, never a hardcoded one", () => {
  assert.equal(USER_AGENT, `ssff-mcp/${manifest.version} (+mcp; linux)`);
});

test("the MCP handshake advertises the package version", async () => {
  const configPath = await writeConfigFile(configJson({ "tenant-a": {} }), { mode: 0o600 });
  await withTestServer({ configPath }, async (client) => {
    assert.equal(client.getServerVersion()?.version, manifest.version);
  });
});
