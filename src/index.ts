#!/usr/bin/env node
/**
 * ssff-mcp entry point: STDIO by default, or authenticated Streamable HTTP.
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
import { runCacheInvalidate } from "./cli/cache.js";
import { runServeHttp } from "./cli/serve.js";
import { runKeyHash } from "./cli/key.js";

const HELP = [
  "ssff-mcp — read-only MCP server for SAP SuccessFactors OData v2",
  "",
  "Usage:",
  "  ssff-mcp          Start the MCP server over STDIO (default)",
  "  ssff-mcp init     Run the interactive configuration wizard",
  "  ssff-mcp serve [--port <1..65535>] [--host <address>] [--config <path>]",
  "                    Start authenticated Streamable HTTP (/mcp and /healthz)",
  "  ssff-mcp key hash Hash a key read from stdin (never pass keys in argv)",
  "  ssff-mcp cache invalidate <alias|--all>   Drop cached $metadata for an environment",
  "  ssff-mcp --help   Show this help",
  "",
  "With no command, a non-empty PORT selects HTTP; otherwise STDIO is unchanged.",
  "HTTP settings: PORT, SSFF_MAX_SESSIONS (50), SSFF_SESSION_IDLE_MS (300000),",
  "SSFF_ALLOWED_HOSTS (comma-separated; defaults to loopback hostnames only).",
].join("\n");

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));

  if (command.kind === "key-hash") {
    process.exitCode = await runKeyHash();
    return;
  }

  if (command.kind === "init") {
    process.exitCode = await runInit();
    return;
  }
  if (command.kind === "serve-http") {
    // Explicit hosted mode (FR-154): Streamable HTTP edge, stays serving.
    await runServeHttp({ port: command.port, host: command.host, configPath: command.configPath });
    return;
  }
  if (command.kind === "serve" && process.env.PORT !== undefined && process.env.PORT.length > 0) {
    // PaaS auto-mode (FR-155): `PORT` present and no subcommand => serve.
    await runServeHttp({});
    return;
  }
  if (command.kind === "cache-invalidate") {
    process.exitCode = await runCacheInvalidate(command.alias, command.all);
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
