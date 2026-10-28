/**
 * Public, type-only contract of the `ssff-mcp` package.
 *
 * `ssff-mcp` is a CLI/MCP server, not a library: this module has no runtime
 * exports. It lets TypeScript users type what they write or send:
 *
 * - `config.json` contents (`ConfigFile`, flat or multi-tenant shape);
 * - the arguments of each MCP tool.
 *
 * Usage: `import type { ConfigFile, QueryEntityArguments } from "ssff-mcp";`
 *
 * Only the names exported here are supported; anything reachable under
 * `dist/src` is internal and may change without notice.
 */

export type { ConfigFile, FlatConfigFile, SecretProvider, TenantsConfigFile } from "./config.js";
export type {
  BatchGetArguments,
  InspectEntityArguments,
  ListEnvironmentsArguments,
  QueryEntityArguments,
  ResolvePicklistArguments,
} from "./tool-catalog.js";
