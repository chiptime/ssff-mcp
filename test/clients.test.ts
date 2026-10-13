import test from "node:test";
import assert from "node:assert/strict";
import { CLIENTS, renderClientBlock } from "../src/cli/clients.js";

const ENV: Record<string, string> = {
  SF_BASE_URL: "https://api2.successfactors.eu",
  SF_USERNAME: "u",
  SF_PASSWORD: "p",
  SF_ENVIRONMENT: "prod",
};

function parseJson(block: string): any {
  return JSON.parse(block);
}

test("CLIENTS lists the five supported clients with paths and formats", () => {
  assert.deepEqual(
    CLIENTS.map((c) => c.id),
    ["codex", "pi", "opencode", "claude-desktop", "cursor"],
  );
  const codex = CLIENTS.find((c) => c.id === "codex")!;
  assert.equal(codex.format, "toml");
  assert.equal(codex.configPath, "~/.codex/config.toml");
  const opencode = CLIENTS.find((c) => c.id === "opencode")!;
  assert.equal(opencode.format, "json");
});

test("codex block is TOML with env_vars for referenced secrets", () => {
  const block = renderClientBlock("codex", { env: ENV });
  assert.match(block, /\[mcp_servers\.ssff-mcp\]/);
  assert.match(block, /command = "npx"/);
  assert.match(block, /args = \["-y", "ssff-mcp@latest"\]/);
  assert.match(block, /env_vars = \["SF_PASSWORD"\]/);
  assert.match(block, /\[mcp_servers\.ssff-mcp\.env\]/);
  assert.match(block, /SF_BASE_URL = "https:\/\/api2\.successfactors\.eu"/);
  assert.ok(!block.includes("SF_PASSWORD = "), "referenced secret must not be emitted as a literal");
});

test("opencode v2 block nests under mcp.servers with environment references", () => {
  const json = parseJson(renderClientBlock("opencode", { env: ENV }));
  const server = json.mcp.servers["ssff-mcp"];
  assert.equal(server.type, "local");
  assert.deepEqual(server.command, ["npx", "-y", "ssff-mcp@latest"]);
  assert.equal(server.environment.SF_PASSWORD, "{env:SF_PASSWORD}");
  assert.equal(server.environment.SF_BASE_URL, "https://api2.successfactors.eu");
});

test("opencode v1 block nests directly under mcp", () => {
  const json = parseJson(renderClientBlock("opencode", { env: ENV, opencodeVersion: "v1" }));
  assert.equal(json.mcp["ssff-mcp"].type, "local");
  assert.equal(json.mcp.servers, undefined);
});

test("claude-desktop block uses mcpServers with env references", () => {
  const json = parseJson(renderClientBlock("claude-desktop", { env: ENV }));
  const server = json.mcpServers["ssff-mcp"];
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "ssff-mcp@latest"]);
  assert.equal(server.env.SF_PASSWORD, "${SF_PASSWORD}");
});

test("cursor and pi blocks use mcpServers with env references", () => {
  for (const id of ["cursor", "pi"] as const) {
    const json = parseJson(renderClientBlock(id, { env: ENV }));
    assert.equal(json.mcpServers["ssff-mcp"].env.SF_PASSWORD, "${SF_PASSWORD}");
  }
});

test("literal mode emits the secret value instead of a reference", () => {
  const codex = renderClientBlock("codex", { env: ENV, secretMode: "literal" });
  assert.match(codex, /SF_PASSWORD = "p"/);
  assert.ok(!codex.includes("env_vars"));
  const opencode = parseJson(renderClientBlock("opencode", { env: ENV, secretMode: "literal" }));
  assert.equal(opencode.mcp.servers["ssff-mcp"].environment.SF_PASSWORD, "p");
});
