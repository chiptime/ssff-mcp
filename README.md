# ssff-mcp

[![npm version](https://img.shields.io/npm/v/ssff-mcp.svg)](https://www.npmjs.com/package/ssff-mcp)
[![license](https://img.shields.io/npm/l/ssff-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/ssff-mcp.svg)](package.json)
[![CI](https://github.com/chiptime/ssff-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chiptime/ssff-mcp/actions/workflows/ci.yml)

A local, **read-only** MCP (Model Context Protocol) server for **SAP
SuccessFactors OData v2**. It lets an AI assistant — OpenCode, Claude Desktop,
Cursor, Codex, Pi, or any MCP client — read your SuccessFactors data safely:
read-only by construction, one page per call, and with no way to write anything.

- **Tools:** `list_environments`, `inspect_entity`, `query_entity`, `batch_get`
- **Resources:** environment overview, entity catalog, per-entity schema, Custom MDF catalog
- **Auth:** Basic or OAuth 2.0, per environment, over HTTPS only
- **Platforms:** Linux, macOS, Windows · **License:** MIT

The server talks to the client over **STDIO** only (no HTTP port anywhere) and
dispatches reads as `HTTPS GET`, exactly one fetch per call. The single
sanctioned `POST` is the fixed, GET-only `$batch` envelope used by `batch_get`
(plus the two fixed OAuth token endpoints). The read-only frontier lives in
server code, never in a prompt.

> **Release status.** The published npm version is **0.3.0**. The `inspect_entity`
> tool, the `ssff-mcp cache invalidate` command, the configurable response-size
> cap and the Custom MDF improvements are on `main` and land in the next release.
> If you need them today, run [from source](#from-source-development).

## Requirements

- **Node.js >= 20** (Linux, macOS, Windows).
- **pnpm** — only if you develop from source. The installed CLI needs nothing beyond Node.

## Install

### From npm (recommended)

Run on demand with `npx`:

```bash
npx -y ssff-mcp@latest
```

Or install globally and call `ssff-mcp`:

```bash
npm install -g ssff-mcp
ssff-mcp
```

With no arguments, `ssff-mcp` starts the MCP server on stdin/stdout. Most people
never run it by hand — the MCP client launches it **as a subprocess** (see
[Connecting your MCP client](#connecting-your-mcp-client)).

### From source (development)

```bash
git clone https://github.com/chiptime/ssff-mcp.git
cd ssff-mcp
pnpm install
pnpm build
pnpm start          # runs: node dist/src/index.js
```

## Quick start

Three steps, about five minutes.

**1. Run the configuration wizard.** It asks for your tenant URL and credentials,
validates them live against `$metadata`, optionally lets you pick an entity
allowlist, writes `~/.config/ssff-mcp/config.json`, and prints the block to paste
into your MCP client.

```bash
npx -y ssff-mcp@latest init
```

**2. Paste the printed block** into your client's config (see
[Connecting your MCP client](#connecting-your-mcp-client)).

**3. Restart the client and ask it something**, for example *"List my
SuccessFactors environments."*

> Prefer no config file at all? Use [inline mode](docs/configuration.md#inline-mode-no-config-file)
> and put `SF_*` environment variables straight into the client block.

## Connecting your MCP client

The server is a local stdio MCP server, so each client launches it as a
subprocess. The wizard prints the exact block for the client you pick; the five
supported shapes are below. With the configuration file holding your
credentials, the block itself carries no secrets.

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

For inline mode (credentials in the block, no config file), the `env` /
`environment` object carries the `SF_*` variables instead of being empty; secret
variables are referenced, not embedded, by the generator.

## Configuration

The wizard writes the config file; the server re-reads it on **every** call. In
short:

- **Path:** `~/.config/ssff-mcp/config.json` (POSIX) or
  `%USERPROFILE%\.config\ssff-mcp\config.json` (Windows).
- **Environments:** `environments.<alias>` with `baseUrl` (https, no `/odata/v2`)
  and `auth` — Basic or OAuth 2.0.
- **Allowlist (optional):** `entityAllowlist` limits which entities are readable.
- **Secrets:** plain text, or `{ "fromEnv": … }` / `{ "fromCommand": […] }` so no
  secret sits on disk.
- **Other:** `defaultLocale` (guidance language) and `maxResponseBytes` (output cap).

Full field reference, inline mode and every option:
**[Configuration →](docs/configuration.md)**.

## How it works

Your assistant speaks **MCP** to `ssff-mcp` over **STDIO**; `ssff-mcp` speaks
**OData v2** to SuccessFactors over **HTTPS**. Nothing is proxied through a third
party, and there is no write path anywhere.

```text
   Assistant (MCP host)          ssff-mcp (local)            SAP SuccessFactors
   ─────────────────────  MCP   ─────────────────  HTTPS   ─────────────────────
   "read EmpJob for ..."  ────►   validate + build  ─────►   OData v2 endpoint
   answer                 ◄────   sanitize + page   ◄─────   one page per call
```

Every call is one **`HTTPS GET`** (plus a fixed, GET-only `$batch` POST for
`batch_get`). The server validates the request, enforces your
[entity allowlist](docs/configuration.md#entity-allowlist), caches only the
`$metadata` schema, and returns at most one page. Not sure whether it fits your
case? See the [FAQ and comparison](docs/faq.md).

## What you can ask

You drive the assistant in natural language; it picks the tool.

- "List my SuccessFactors environments."
- "Which entities can I read, and which of them are custom?"
- "Show me the schema of `EmpJob` — keys, fields and navigations."
- "Read the current job info for employee `1000001`."
- "Get the employees in `PerPersonal` whose last name is García, with id, name and email."
- "Fetch these five entities at once: …" *(one `$batch` request)*

See [Examples](docs/tools.md#examples-what-you-ask-what-happens) for what each
prompt triggers under the hood.

## Demo

An abridged sample session — the assistant picks the tools (output shapes are
real; values are illustrative):

```text
You        Which SuccessFactors environments do I have configured?

Assistant  calls list_environments ->
           { "environments": [ { "alias": "prod", "authType": "basic" } ] }

You        Show me the fields of EmpJob.

Assistant  calls inspect_entity ->
           keys: seqNumber, userId, effectiveStartDate
           navigation: userNav -> User

You        Read the current job info for employee 1000001.

Assistant  calls query_entity ->
           { "recordCount": 1, "hasMore": false, "records": [ { "jobTitle": "..." } ] }
```

<!-- To show a recorded GIF instead: add docs/assets/demo.gif and replace the transcript above with ![demo](docs/assets/demo.gif). -->

## Documentation

| Document | Contents |
|---|---|
| [Configuration](docs/configuration.md) | Config path, fields, Basic/OAuth auth, secret providers, entity allowlist, inline mode, locale, response-size cap. |
| [Tools & Resources](docs/tools.md) | The four tools and their arguments, query encoding and effective dating, pagination/cursors, MCP resources, Custom MDF discovery, examples. |
| [FAQ & comparison](docs/faq.md) | Common questions and how it compares to the SF UI, raw OData and ad-hoc scripts. |
| [Security](docs/security.md) | Read-only guarantees, secrets, logging, metadata cache, limits and scope. |
| [Troubleshooting](docs/troubleshooting.md) | Every error code and how to fix it. |
| [Development](docs/development.md) | Build, test, the opt-in integration test, contributing. |

## Contributing

Issues and pull requests are welcome at
[chiptime/ssff-mcp](https://github.com/chiptime/ssff-mcp). See
[Development](docs/development.md) for the build, the test suite and the opt-in
integration test. Please keep changes read-only in spirit: this server must never
gain the ability to write to SuccessFactors.

## Maintainers

[@chiptime](https://github.com/chiptime).

## License

[MIT](LICENSE) — Copyright (c) 2026 ChipTime. Published on npm as
[`ssff-mcp`](https://www.npmjs.com/package/ssff-mcp).
