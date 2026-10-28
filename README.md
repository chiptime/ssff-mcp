# ssff-mcp

[![npm version](https://img.shields.io/npm/v/ssff-mcp.svg)](https://www.npmjs.com/package/ssff-mcp)
[![license](https://img.shields.io/npm/l/ssff-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/ssff-mcp.svg)](package.json)
[![CI](https://github.com/chiptime/ssff-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chiptime/ssff-mcp/actions/workflows/ci.yml)
[![MCP Badge](https://lobehub.com/badge/mcp/chiptime-ssff-mcp)](https://lobehub.com/mcp/chiptime-ssff-mcp)

![ssff-mcp — read-only MCP server for SAP SuccessFactors OData v2](assets/banner.svg)

A local, **read-only** MCP (Model Context Protocol) server for **SAP
SuccessFactors OData v2**. It lets an AI assistant — OpenCode, Claude Desktop,
Cursor, Codex, Pi, or any MCP client — read your SuccessFactors data through
natural language, safely: read-only by construction, one page per call, and with
no way to write anything.

> **Release status.** Published on npm — the
> [registry page](https://www.npmjs.com/package/ssff-mcp) always shows the latest
> published version, and [CHANGELOG.md](CHANGELOG.md) documents what each release
> contains. Anything described here but missing from the changelog is still on
> `main`: [build from source](docs/development.md#build-and-test) if you need it today.

## 🆚 ssff-mcp vs calling OData directly

You could write your own SuccessFactors client, but you would handle auth and
token refresh, effective dating, `$batch` envelopes, cursor pagination, error
sanitization and — above all — the read-only boundary yourself. `ssff-mcp` is
exactly that layer, packaged for any MCP client, and it refuses to write by
construction. See the full [comparison](docs/faq.md#how-it-compares).

## ✨ Key features

- **Read-only by construction.** No tool can write; the boundary lives in server
  code, never in a prompt.
- **Schema-aware.** `inspect_entity` and MCP resources browse the data model
  without spending a data query.
- **Safe by default.** HTTPS-only, sanitized errors, metadata-only stderr logs,
  secrets never logged.
- **Efficient reads.** One page per call, signed cursor continuation, and one
  GET-only `$batch` for up to 180 reads.
- **Any MCP client.** A local STDIO server — no HTTP port, no third-party proxy.
- **Cross-platform.** Linux, macOS and Windows; Basic or OAuth 2.0 per
  environment.

## 📋 Requirements

- **Node.js >= 20** (Linux, macOS, Windows).
- Any MCP client: OpenCode, Claude Desktop, Cursor, Codex, Pi, or another.
- **pnpm** — only if you build from source. The installed CLI needs nothing
  beyond Node.

## 🚀 Getting started

Run the configuration wizard — it asks for your tenant URL and credentials,
validates them live against `$metadata`, writes `~/.config/ssff-mcp/config.json`
and prints the block for your client:

```bash
npx -y ssff-mcp@latest init
```

Then paste that block into your client and restart it. Already have a
configuration file? The **standard config** works in most tools:

```json
{
  "mcpServers": {
    "ssff-mcp": {
      "command": "npx",
      "args": ["-y", "ssff-mcp@latest"]
    }
  }
}
```

<details>
<summary><b>OpenCode</b> — <code>opencode.json</code></summary>

```json
{
  "mcp": {
    "servers": {
      "ssff-mcp": {
        "type": "local",
        "command": ["npx", "-y", "ssff-mcp@latest"],
        "environment": {}
      }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "ssff-mcp": {
      "command": "npx",
      "args": ["-y", "ssff-mcp@latest"],
      "env": {}
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "ssff-mcp": {
      "command": "npx",
      "args": ["-y", "ssff-mcp@latest"],
      "env": {}
    }
  }
}
```
</details>

<details>
<summary><b>Pi</b> — <code>~/.pi/agent/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "ssff-mcp": {
      "command": "npx",
      "args": ["-y", "ssff-mcp@latest"],
      "env": {}
    }
  }
}
```
</details>

<details>
<summary><b>Codex</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.ssff-mcp]
command = "npx"
args = ["-y", "ssff-mcp@latest"]
```
</details>

Install globally instead of with `npx` (`npm install -g ssff-mcp`, then run
`ssff-mcp`), or [build from source](docs/development.md#build-and-test).

## ⚙️ Configuration

### Hosted service (Streamable HTTP)

The hosted mode provides `ssff-mcp serve`: an authenticated service
with isolated tenants, environment-scoped legacy keys, and fixed MCP users with
personal tokens and tenant-local roles. Local STDIO stays the
default (a non-empty `PORT` selects HTTP). For the Dokploy pilot — mounted config,
TLS, secrets, and remote-client examples — see **[Hosting →](docs/hosting.md)**.
Hosted mode and personal tokens ship in the stable `0.7.0` release; no finished
production deployment or IAS integration is claimed. For local users, token
rotation/revocation and a loopback backend behind HTTPS, see
**[Personal-token hosting →](docs/local-users-hosting.md)**.
Maintainers: [release publication checklist](docs/release-0.7.0.md).

The usual way is the `ssff-mcp init` wizard (see Getting started above): it
writes `~/.config/ssff-mcp/config.json` and prints the block for your client. To
edit the file by hand, or for OAuth, the per-environment entity allowlist and
denylist, secret providers and inline mode, see **[Configuration →](docs/configuration.md)**.

## 💬 What you can ask

You drive the assistant in natural language; it picks the tool.

- "List my SuccessFactors environments."
- "Which entities can I read, and which of them are custom?"
- "Show me the schema of `EmpJob` — keys, fields and navigations."
- "Read the current job info for employee `1000001`."
- "Get the employees in `PerPersonal` whose last name is García, with id, name and email."
- "Fetch these five entities at once: …" *(one `$batch` request)*

## 🎬 Demo

The assistant picks the tools and answers from the records it reads (output
shapes are real; values are illustrative):

![Example session: list_environments, inspect_entity and query_entity](assets/demo.svg)

## 🔒 Security

`ssff-mcp` is read-only by construction: no POST/PUT/PATCH/DELETE can come from
tool input, credentials travel over HTTPS only (or not at all, in inline mode),
errors are sanitized and logs are metadata-only on stderr. Use a
least-privileged, read-only SuccessFactors account. Details in
[Security](docs/security.md).

## 🧰 Tools

| Tool | What it does |
|---|---|
| `list_environments` | Lists the configured environments (aliases and auth type). |
| `inspect_entity` | Reads the data model: entity catalog, schema and Custom MDF classification. |
| `resolve_picklist` | Resolves option IDs to labels, lists catalog options, or searches by label for `$filter`. |
| `query_entity` | Reads one entity with `$filter`/`$orderby`/`$select`/`$expand`/`$top`/`$skip` and effective dating. |
| `batch_get` | Runs up to 180 read-only GETs in one GET-only `$batch` request. |

Plus read-only [MCP resources](docs/tools.md#mcp-resources) for browsing the
schema, and two [MCP prompts](docs/tools.md#mcp-prompts) (`explore_entity`,
`prepare_read_query`) that guide the assistant through schema inspection and a
bounded, confirmed read. Full argument reference:
**[Tools & Resources →](docs/tools.md)**.

## 📚 Documentation

| Document | Contents |
|---|---|
| [Configuration](docs/configuration.md) | Config path, fields, Basic/OAuth auth, secret providers, entity allowlist, inline mode, locale, response-size cap. |
| [Picklists Architecture](docs/picklists.md) | Picklist resolution, two-tier L1/L2 lazy cache, ID retention (`optionId` + `label`), pagination and invalidation. |
| [Tools & Resources](docs/tools.md) | The five tools and their arguments, query encoding and effective dating, pagination/cursors, MCP resources and prompts, Custom MDF discovery, picklist resolution, examples. |
| [FAQ & comparison](docs/faq.md) | Common questions and how it compares to the SF UI, raw OData and ad-hoc scripts. |
| [Security](docs/security.md) | Read-only guarantees, secrets, logging, metadata cache, limits and scope. |
| [Troubleshooting](docs/troubleshooting.md) | Every error code and how to fix it. |
| [Development](docs/development.md) | Build, test, the opt-in integration test, contributing. |

## 🤝 Contributing

Issues and pull requests are welcome at
[chiptime/ssff-mcp](https://github.com/chiptime/ssff-mcp). See
[Development](docs/development.md) for the build, the test suite and the opt-in
integration test. Please keep changes read-only in spirit: this server must never
gain the ability to write to SuccessFactors.

## 👤 Maintainers

[@chiptime](https://github.com/chiptime).

## 📄 License

[MIT](LICENSE) — Copyright (c) 2026 ChipTime. Published on npm as
[`ssff-mcp`](https://www.npmjs.com/package/ssff-mcp).
