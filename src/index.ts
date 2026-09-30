#!/usr/bin/env node
/**
 * ssff-mcp entry point: STDIO transport only, no HTTP listener.
 *
 * Configuration is NOT loaded at startup: every tool call re-reads and
 * re-validates ~/.config/ssff-mcp/config.json (stateless per PRD C.2), so a
 * missing config does not prevent the server from starting and reporting the
 * exact remediation via CONFIG_MISSING.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ssff-mcp failed to start: ${message}\n`);
  process.exit(1);
});
