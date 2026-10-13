/**
 * MCP client configuration block generation (FR-55 / D-50 / PRD §6.1).
 *
 * There is NO single JSON shape: Codex uses TOML, and the JSON clients differ
 * in nesting (`mcp` vs `mcpServers`) and env key (`environment` vs `env`).
 * Secrets default to references; `secretMode: "literal"` embeds the raw value.
 */

export type ClientId = "codex" | "pi" | "opencode" | "claude-desktop" | "cursor";

export interface ClientBlockSpec {
  /** MCP server name; defaults to "ssff-mcp". */
  serverName?: string;
  /** SF_* environment entries (real values; the generator decides reference vs literal). */
  env: Record<string, string>;
  /** "reference" (default) emits secret references; "literal" embeds the raw value. */
  secretMode?: "reference" | "literal";
  /** OpenCode config generation: v2 nests under `mcp.servers` (default). */
  opencodeVersion?: "v1" | "v2";
}

export interface ClientDescriptor {
  id: ClientId;
  label: string;
  configPath: string;
  format: "toml" | "json";
}

export const SECRET_ENV_KEYS: readonly string[] = ["SF_PASSWORD", "SF_PRIVATE_KEY"];

export const CLIENTS: readonly ClientDescriptor[] = [
  { id: "codex", label: "Codex", configPath: "~/.codex/config.toml", format: "toml" },
  { id: "pi", label: "Pi", configPath: "~/.pi/agent/mcp.json", format: "json" },
  { id: "opencode", label: "OpenCode", configPath: "opencode.json", format: "json" },
  { id: "claude-desktop", label: "Claude Desktop", configPath: "claude_desktop_config.json", format: "json" },
  { id: "cursor", label: "Cursor", configPath: "~/.cursor/mcp.json", format: "json" },
];

const DEFAULT_SERVER_NAME = "ssff-mcp";
const COMMAND = "npx";
const ARGS = ["-y", "ssff-mcp@latest"];

function isSecret(name: string): boolean {
  return SECRET_ENV_KEYS.includes(name);
}

/** Split env into referenced secrets and literal entries, honouring secretMode. */
function splitEnv(spec: ClientBlockSpec): { references: string[]; literals: Record<string, string> } {
  const mode = spec.secretMode ?? "reference";
  const references: string[] = [];
  const literals: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    if (mode === "reference" && isSecret(name)) {
      references.push(name);
    } else {
      literals[name] = value;
    }
  }
  return { references, literals };
}

/** Env map where referenced secrets use the client's own reference syntax. */
function envMap(spec: ClientBlockSpec, reference: (name: string) => string): Record<string, string> {
  const mode = spec.secretMode ?? "reference";
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    out[name] = mode === "reference" && isSecret(name) ? reference(name) : value;
  }
  return out;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodex(spec: ClientBlockSpec): string {
  const name = spec.serverName ?? DEFAULT_SERVER_NAME;
  const { references, literals } = splitEnv(spec);
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(COMMAND)}`,
    `args = [${ARGS.map(tomlString).join(", ")}]`,
  ];
  if (references.length > 0) {
    lines.push(`env_vars = [${references.map(tomlString).join(", ")}]`);
  }
  if (Object.keys(literals).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(literals)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderJson(server: Record<string, unknown>, root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 2)}\n`;
}

function renderOpenCode(spec: ClientBlockSpec): string {
  const name = spec.serverName ?? DEFAULT_SERVER_NAME;
  const server = {
    type: "local",
    command: [COMMAND, ...ARGS],
    environment: envMap(spec, (n) => `{env:${n}}`),
  };
  const version = spec.opencodeVersion ?? "v2";
  const mcp = version === "v1" ? { [name]: server } : { servers: { [name]: server } };
  return renderJson(server, { mcp });
}

function renderMcpServers(spec: ClientBlockSpec): string {
  const name = spec.serverName ?? DEFAULT_SERVER_NAME;
  const server = {
    command: COMMAND,
    args: [...ARGS],
    env: envMap(spec, (n) => `\${${n}}`),
  };
  return renderJson(server, { mcpServers: { [name]: server } });
}

export function renderClientBlock(id: ClientId, spec: ClientBlockSpec): string {
  switch (id) {
    case "codex":
      return renderCodex(spec);
    case "opencode":
      return renderOpenCode(spec);
    case "claude-desktop":
    case "cursor":
    case "pi":
      return renderMcpServers(spec);
  }
}
