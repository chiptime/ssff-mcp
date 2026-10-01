# ssff-mcp

A local, **read-only** MCP (Model Context Protocol) server for **SAP SuccessFactors OData v2**, communicating with the MCP host exclusively over **STDIO**. It exposes three tools (`list_environments`, `get_metadata`, `query_entity`) that dispatch exactly one HTTPS GET per data call, with the read-only frontier enforced in server code — never in prompts.

**Status:** private, NOT published, `"license": "UNLICENSED"` (license decision pending). Linux-only MVP; OpenCode is the first target client.

## Requirements

- Linux
- Node.js >= 20
- pnpm

## Install

```bash
pnpm install
pnpm build
```

Run manually (it speaks MCP on stdin/stdout):

```bash
pnpm start
```

## Configuration

The configuration lives at the exact path **`~/.config/ssff-mcp/config.json`** (per-user, outside this repository). `XDG_CONFIG_HOME` is deliberately not honored.

1. Create the directory: `mkdir -p ~/.config/ssff-mcp`
2. Copy the template: `cp config.template.json ~/.config/ssff-mcp/config.json`
3. Fill in the placeholders.
4. Restrict permissions: `chmod 600 ~/.config/ssff-mcp/config.json`

The file is re-read and re-validated on **every tool call** (stateless). It is never logged and never persisted elsewhere by the server.

### Fields

| Field | Meaning |
|---|---|
| `environments` | Required object; may be empty. Keys are environment aliases you choose (for example `prod`, `staging`). |
| `environments.<alias>.baseUrl` | Tenant API origin, for example `https://api4.successfactors.com`. Must be `https`, no credentials/userinfo, no query string or fragment. A path prefix is allowed. The server appends `/odata/v2` — do not include it yourself. |
| `environments.<alias>.auth.type` | `"basic"` or `"oauth"` (see the OAuth section below). |
| `environments.<alias>.auth.username` | Basic auth API username. SuccessFactors API users are often of the form `user@companyId`. |
| `environments.<alias>.auth.password` | Basic auth API password. Stored in plain text — see security disclosures below. |
| `defaultEnvironment` | Optional. If present it MUST be `null`. Any non-null value is rejected: implicit environment selection is forbidden. |

### OAuth 2.0 (alternative to Basic, per environment)

Set `auth.type` to `"oauth"` to use the SAP SuccessFactors OAuth 2.0 flow
(grant `urn:ietf:params:oauth:grant-type:saml2-bearer` via SAP's IdP helper — no local
SAML signing, no extra dependencies):

| Field | Meaning |
|---|---|
| `auth.clientId` | OAuth2 client **API key** generated when the client was registered in SF Admin Center (Manage OAuth2 Client Applications). |
| `auth.companyId` | Tenant company id; sent as `company_id` to the token endpoint. |
| `auth.userId` | Technical user id **WITHOUT** the `@companyId` suffix (configurations containing `@` are rejected with a hint). |
| `auth.privateKey` | The private key value **exactly as exported/stored** (a single line; it may be a composite value such as `<base64>/<base64>`). Paste it **verbatim: never decode, re-encode or retype it** (copy it programmatically if it is long). Inline plain text — see security disclosures. |
| `auth.tokenUrl` | Fixed token endpoint, e.g. `https://<host>/oauth/token`. Must be `https`. Must match exactly what SAP expects (SAP embeds it in the assertion audience). |
| `auth.idpUrl` | Optional. SAP IdP helper endpoint; defaults to the `tokenUrl` origin + `/oauth/idp`. |

Flow (automatic, per tool call when needed): `POST {idpUrl}` with
`{client_id, user_id, token_url, private_key}` returns a signed SAML assertion;
`POST {tokenUrl}` with `{client_id, grant_type, company_id, assertion}` returns the
bearer token (`expires_in` ≈ 24h). Tokens are cached **in memory per environment
only** (until the process restarts), refreshed with a 60s/10% safety margin, and a
401 on a data read triggers exactly one invalidation + retry. These two POSTs are the
only non-GET requests the server can ever issue.

**Prerequisite:** the client machine's IP must be whitelisted in SF Admin Center
(Password & Login Policy Settings → API login exceptions) or the token endpoints will
reject the connection.

### Multiple environments example

```json
{
  "environments": {
    "prod": {
      "baseUrl": "https://api4.successfactors.com",
      "auth": { "type": "basic", "username": "integration@mycompany", "password": "<secret>" }
    },
    "staging": {
      "baseUrl": "https://custom-staging.example.com/api",
      "auth": { "type": "basic", "username": "integration@mycompany", "password": "<secret>" }
    }
  }
}
```

Every tool call names its environment explicitly. Unknown or missing environment ⇒ the call is rejected (fail-closed); the server never picks an implicit environment and never retries against another one.

## Security disclosures (read before using)

- **The configuration file contains secrets in PLAIN TEXT.** Git-ignoring it is NOT encryption. Restrict it with `chmod 600 ~/.config/ssff-mcp/config.json`. Never copy the real file into the repository (`config.json` is gitignored defensively for this reason).
- **OAuth private keys are also plain text**, and with SAP's IdP-helper flow the key additionally transits HTTPS to the configured `idpUrl` on each assertion acquisition (endpoints are fixed per environment in your config). Local signing (key never leaves the process) is a possible future improvement; today's behavior matches the standard SAP helper flow.
- **OAuth tokens never touch disk, logs, or error messages.** They live in process memory only and die with the process.
- **The tenant account MUST be least-privileged and read-only.** This MCP enforces read-only behavior client-side, but source-side permissions are an acceptance condition: verify the account's roles in the tenant. What the account can read, this server can read.
- **All traffic to the tenant uses HTTPS.** Basic Auth credentials are only ever sent over TLS, and redirects are followed only to the same https host configured for the environment.
- **Errors are sanitized.** Errors returned to the model are `{ code, message }` (plus optional `httpStatus`) with URLs redacted from service messages and generic wording for network failures (no hostnames).
- **Logs are metadata-only, on stderr.** One JSON line per tool call: `{ ts, tool, environment, outcome, code?, durationMs, recordCount? }`. No URLs, no entity paths, no query values, no bodies, no credentials. stdout carries only the MCP protocol.
- **No data persistence.** No response bodies, credentials, or metadata documents are written to disk. The only cache is in-memory (see Implementation decisions).

## OpenCode wiring

In `opencode.json`:

```json
{
  "mcp": {
    "ssff": {
      "type": "local",
      "command": ["node", "/absolute/path/to/ssff-mcp/dist/src/index.js"]
    }
  }
}
```

## Tools reference

### `list_environments` (no arguments)

Returns `{ environments: [{ alias, authType }] }` — aliases and auth type only. No URLs, no credentials. No network access.

### `get_metadata` — arguments: `{ environment }`

Fetches `{serviceRoot}/$metadata` (GET, `Accept: application/xml`, 60s timeout) and returns the **raw, unfiltered XML document** as text. **Warning:** the full metadata can be very large (thousands of entity types); prefer `query_entity` for targeted data.

### `query_entity` — arguments

| Argument | Maps to | Constraints |
|---|---|---|
| `environment` | — | Required; must be a configured alias. |
| `entityPath` | resource path | Required. Examples: `User`, `User('123')`, `Foobar(key1='a',key2=1)/navProperty`. Max 4 segments, max 512 chars; `$`-prefixed segments (e.g. `$batch`, `$value`, `$count`) are rejected. The first segment must be a declared entity set in the tenant's `$metadata` (function imports are rejected). |
| `filter` | `$filter` | Raw value, passed through unmodified. |
| `orderby` | `$orderby` | Raw value, passed through unmodified. |
| `select` | `$select` | Raw value, passed through unmodified. |
| `expand` | `$expand` | Raw value, passed through unmodified. |
| `top` | `$top` | Integer >= 1. Values above 1000 are clamped to 1000 and flagged (`topClamped: true`). |
| `skip` | `$skip` | Integer 0..1,000,000. |

Unknown option names are structurally impossible: the tool schema is typed and strict, so there is no passthrough map to smuggle arbitrary query options.

Response (`structuredContent`): `{ environment, path, recordCount, records, hasMore, topClamped?, truncatedToCeiling? }`. Records are preserved **verbatim** with native SuccessFactors fields (`__metadata` kept, no normalization).

**Pagination ceiling:** at most **1,000 records** and exactly **one OData page** per call. Next links (`__next`) are never followed automatically and never returned; `hasMore` merely reports that a next page exists. If a page somehow contains more than 1,000 records, it is truncated to 1,000 (`truncatedToCeiling: true`).

**Continuation in this MVP** means re-issuing an explicit call with `skip`. Note that SAP cautions that client-side `$top`/`skip` paging can lose or duplicate records at volume (SAP KBA 2675265); cursor-based continuation is planned for Phase 2.

## Limitations & MVP scope

- OData **v2 only**; OData v4 arrives in Phase 2.
- **No entity allowlist** in the MVP: reads are bounded by the tenant account's permissions.
- **No function imports / custom service operations** (rejected with `FUNCTION_IMPORT_UNSUPPORTED`).
- **No writes of any kind**: no POST/PUT/PATCH/DELETE/MERGE, no `$batch`, no method-tunneling headers (there is no input surface for headers at all).
- **No cursor-based pagination** (Phase 2), no OAuth (Phase 2), no `batch_get` (Phase 2), no JSON/XML output selection (JSON only in the MVP).
- **Basic Auth only**, over HTTPS only.
- **Linux + STDIO only**; no HTTP listener exists anywhere in the server.

## Implementation decisions

Resolutions of the PRD open points, as recorded in the feature decision log:

- **Q-1 (config schema + template name):** MVP schema is the illustrative skeleton from PRD C.1 — `environments.<alias>.baseUrl` plus `auth { type, username, password }`, with `defaultEnvironment` required to be null/absent. Template file name: `config.template.json`.
- **Q-2 (MVP query option subset):** `$filter`, `$orderby`, `$select`, `$expand`, `$top`, `$skip` are exposed as typed tool fields (`filter`, `orderby`, `select`, `expand`, `top`, `skip`). Unknown option names are structurally rejected (schema-typed input, no passthrough map). Raw values pass through unmodified.
- **A-1 (tool names):** `list_environments` (read-only, aliases only — helps fail-closed environment UX), `get_metadata`, `query_entity`.
- **Transient metadata cache (PRD left it undefined):** in-memory, per-process, TTL 10 minutes, storing only parsed entity-set and function-import **name sets** (used for function-import exclusion per DS-04/FR-08). No disk, no bodies, no credentials. `get_metadata` itself always hits the source fresh and never uses this cache.
- **Ceiling semantics:** `$top` above 1000 is clamped to 1000 (flagged in the response); responses are truncated to 1000 records if a service ever returns more (DS-10 defense in depth). Exactly one page / one data fetch per call; `__next` is never followed, only reported as `hasMore`.

## Testing

```bash
pnpm test
```

Builds the project and runs the suite (`node --test dist/test/`). The negative suite is the point: write-shape rejection before dispatch, fail-closed environment handling, redirect blocking, error sanitization, the pagination ceiling and log-field allowlists are all covered by automated tests.

## License

None granted yet (`"license": "UNLICENSED"`, `private: true`). Publication is not authorized; the license decision is pending.
