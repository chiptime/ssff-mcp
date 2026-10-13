#!/usr/bin/env node
/**
 * ssff-mcp entry point: STDIO transport only, no HTTP listener.
 *
 * `ssff-mcp` (no args) starts the MCP server; `ssff-mcp init` runs the
 * interactive configuration wizard and never starts the server.
 *
 * Configuration is NOT loaded at startup: every tool call re-reads and
 * re-validates the config (stateless), so a missing config does not prevent
 * the server from starting and reporting the exact remediation via
 * CONFIG_MISSING.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";
import { parseCliArgs, runInit } from "./cli/init.js";

const HELP = [
  "ssff-mcp — read-only MCP server for SAP SuccessFactors OData v2",
  "",
  "Usage:",
  "  ssff-mcp          Start the MCP server over STDIO (default)",
  "  ssff-mcp init     Run the interactive configuration wizard",
  "  ssff-mcp --help   Show this help",
  "",
].join("\n");

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.kind === "init") {
    process.exitCode = await runInit();
    return;
  }
  if (command.kind === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command.kind === "unknown") {
    process.stderr.write(`ssff-mcp: unknown command "${command.arg}"; run ssff-mcp --help\n`);
    process.exitCode = 2;
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ssff-mcp failed to start: ${message}\n`);
  process.exit(1);
});
