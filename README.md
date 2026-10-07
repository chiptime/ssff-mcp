# ssff-mcp

A local, **read-only** MCP (Model Context Protocol) server for **SAP SuccessFactors OData v2**, communicating with the MCP host exclusively over **STDIO**. It exposes four tools (`list_environments`, `get_metadata`, `query_entity`, `batch_get`); data reads dispatch exactly one HTTPS GET per call, and `batch_get` dispatches exactly one HTTPS POST to the fixed `$batch` endpoint with a GET-only multipart envelope — with the read-only frontier enforced in server code, never in prompts.

**Status:** MIT licensed and **published on npm** ([ssff-mcp](https://www.npmjs.com/package/ssff-mcp)). Linux-only MVP; OpenCode is the first target client.

## Requirements

- Linux
- Node.js >= 20
- pnpm — **only for developing from source**; the installed CLI needs nothing beyond Node

## Install

### From source (development)

```bash
pnpm install
pnpm build
```

Run manually (it speaks MCP on stdin/stdout):

```bash
pnpm start
```

### Installed CLI (npm)

```bash
npx -y ssff-mcp
```

or install globally (`npm install -g ssff-mcp`) and run `ssff-mcp`. The
installed CLI requires only Node >= 20; the configuration below is still
required.

## Configuration

The configuration lives at the exact path **`~/.config/ssff-mcp/config.json`** (per-user, outside this repository). `XDG_CONFIG_HOME` is deliberately not honored.

1. Create the directory: `mkdir -p ~/.config/ssff-mcp`
2. Copy the template: `cp config.template.json ~/.config/ssff-mcp/config.json`
   (for a packaged install, copy it from the installed package instead:
   `cp "$(npm root -g)/ssff-mcp/config.template.json" ~/.config/ssff-mcp/config.json`
   for a global install — `node_modules/ssff-mcp/config.template.json` relative
   to the install for anything else — or fetch it from the repository). The
   template ships inside the npm package with safe placeholders.
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
| `entityAllowlist` | Optional array. See [Entity allowlist](#entity-allowlist-optional) below. |

### Entity allowlist (optional)

`entityAllowlist` restricts which entity sets `query_entity` may read. It is a
local, explicit scope control on top of the tenant account's permissions.

| Field | Meaning |
|---|---|
| `entity` | OData entity set name (for example `User`). Matched case-sensitively and exactly against the FIRST path segment of the query. |
| `protocols` | Optional. Array of `"v2"` and/or `"v4"`, without duplicates. Omitted means both protocols. |

Semantics:

- **Absent** — no allowlist: every entity the account can read is reachable (default behavior).
- **Present** — only the listed entities are queryable; any other entity is rejected with `ENTITY_NOT_ALLOWED` before any network request (not even `$metadata` is fetched for a denied query).
- **`[]` (empty array)** — a configured deny-all: every `query_entity` call is rejected. Deliberate fail-closed behavior, not "no allowlist".
- **`protocols`** — omitted = both protocols; `["v2"]` = v2 only. This phase is v2-only, so an entry whose `protocols` exclude `"v2"` (for example `["v4"]`) is **denied** — without v4 there is no available protocol for that entity.
- **Navigation** — only the first path segment is checked: once a query starts from a listed entity, navigation segments after it (`User('123')/navProperty`) are not re-checked.
- **`get_metadata` is never filtered** by the allowlist; it always returns the raw, complete `$metadata` document.

```json
{
  "environments": {
    "prod": {
      "baseUrl": "https://api4.successfactors.com",
      "auth": { "type": "basic", "username": "integration@mycompany", "password": "<secret>" }
    }
  },
  "entityAllowlist": [
    { "entity": "User" },
    { "entity": "JobRequisition", "protocols": ["v2"] }
  ]
}
```

The key is deliberately NOT part of `config.template.json`: a copied template
must not silently activate an allowlist. Invalid allowlists (bad entity names,
empty/duplicate/unknown `protocols`, duplicate entities, unknown keys) are
rejected with `CONFIG_INVALID`.

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
| `skip` | `$skip` | Integer 0..1,000,000. Cannot be combined with `cursor`. |
| `cursor` | `$skiptoken` | Opaque continuation cursor from a previous response (see below). Must be replayed with the SAME `environment`, `entityPath` and options as the call that produced it; otherwise `CURSOR_INVALID`. |
| `inlinecount` | `$inlinecount` | Only `"allpages"`. Adds `$inlinecount=allpages`; the response includes `totalCount` when the service provides `__count`. |
| `output` | — | `"json"` (default) or `"xml"` (raw service XML body, Atom, `Accept: application/atom+xml`, native fields, no normalization). Data fields and raw XML are preserved, except that the `<link rel="next">` **href is stripped** from the returned body (DS-P2-06): neither the service next URL nor the raw `$skiptoken` appears in the output; continuation is exposed only as the opaque `cursor`. A body without a next link is returned byte-for-byte unchanged. |

Unknown option names are structurally impossible: the tool schema is typed and strict, so there is no passthrough map to smuggle arbitrary query options.

Response (`structuredContent`, JSON output): `{ environment, path, recordCount, records, hasMore, topClamped?, truncatedToCeiling?, totalCount?, cursor? }`. Records are preserved **verbatim** with native SuccessFactors fields (`__metadata` kept, no normalization). `totalCount` appears only when the service returns `__count`; `cursor` appears only when `hasMore` is true **and** a `$skiptoken` could be extracted from the service's next link (continuation is never invented).

Response (`structuredContent`, XML output): `{ environment, path, contentType: "xml", hasMore, cursor?, totalCount? }` — the tool text is the **raw XML body** with all data fields and native XML preserved **except the next-link href**: the `href` of the Atom `<link rel="next">` is stripped before the body is returned (DS-P2-06), so neither the service URL nor the raw `$skiptoken` ever appears in the output; continuation is exposed only as the opaque `cursor`. `hasMore`/`cursor`/`totalCount` are derived from the original `<link rel="next">` href and `<m:count>` elements before sanitization. XML cannot be truncated safely, so a response with more than 1,000 `<entry>` elements is rejected with `RESPONSE_INVALID` instead of being cut.

**Pagination ceiling:** at most **1,000 records** and exactly **one OData page** per call. Next links (`__next`) are never followed automatically and never returned; `hasMore` merely reports that a next page exists. If a page somehow contains more than 1,000 records, it is truncated to 1,000 (`truncatedToCeiling: true`).

**Continuation (cursor):** when `hasMore` is true and the service's next link carries a `$skiptoken`, the response includes an opaque `cursor`. To fetch the exact next page, re-issue the **same** call (same `environment`, `entityPath` and options) passing that cursor in the `cursor` argument; the server appends the wrapped `$skiptoken` verbatim. The cursor is a stateless HMAC-SHA256-signed envelope (base64url payload + signature) around the service's own `$skiptoken`, bound to environment + entity path + the canonical query options (`filter`, `orderby`, `select`, `expand`, `top`, `inlinecount`, `output` — not `skip`). There is **no server-side storage and no clock-based TTL**; the HMAC secret is random per process, so **every cursor becomes invalid when the server process restarts** — after a restart, simply run a fresh query. An altered cursor, one reused with different arguments, or one issued by a previous process run is rejected with `CURSOR_INVALID` **before any network dispatch**. `skip` and `cursor` are mutually exclusive (`OPTION_INVALID`). Cursor errors never echo the token or the skiptoken.

### `batch_get` — arguments

Executes multiple read-only OData v2 GETs in **one** `$batch` POST. The multipart envelope is built exclusively by [`odata-batch`](https://www.npmjs.com/package/odata-batch) 2.1.0's **retrieve mode**, which emits **direct GET parts without changesets**; the library's write API (changesets, methods, bodies) is never exposed to any input. The envelope travels through a narrow custom transport that validates it before dispatch (fixed `$batch` URL, expected boundary, every inner line `GET ... HTTP/1.1`, no changeset delimiter) and accepts only the controlled outer headers `Authorization`, `Accept`, `Content-Type` and `User-Agent`.

| Argument | Constraints |
|---|---|
| `environment` | Required; must be a configured alias. |
| `requests` | Array of **1..180 items** (SAP `$batch` hard limit). Each item uses exactly the `query_entity` GET grammar: `entityPath` (required) plus optional `filter`, `orderby`, `select`, `expand`, `top`, `skip`, `cursor`, `inlinecount`. There is **no field** for HTTP method, URL, host, headers, body or changesets; unknown keys are rejected by the strict schema before dispatch. |
| `output` | `"json"` (default) or `"xml"`, global for the whole call. `xml` returns each item's raw Atom body (`Accept: application/atom+xml` on every embedded request). |

Behavior:

- **Full preflight before the POST:** every item is validated (path grammar, `entityAllowlist`, option bounds, cursor binding, `$metadata` classification — function imports and unknown entity sets rejected) **before** the `$batch` POST is built. One invalid item rejects the whole batch; the only allowed pre-batch call is the `$metadata` classification GET (cached 10 min).
- **One POST, one page per item:** exactly one POST to `{serviceRoot}$batch`; pages are never followed or combined automatically. Embedded requests carry **literal `$` query options** (`$top`, `$skiptoken`, …): SAP's `$batch` does not percent-decode inner request targets, so the server decodes `%24` before embedding (verified live; without it `$top`/cursor replay would silently no-op).
- **Per-item results in input order:** `{ index, path, success, httpStatus, recordCount, records|body, hasMore, cursor?, totalCount?, topClamped?, truncatedToCeiling? }`. Embedded non-2xx parts become **sanitized per-item errors** (`error.code`/`error.message`, URLs redacted) — the call itself still succeeds; raw embedded error bodies are never returned.
- **Aggregate ceiling:** at most **1,000 records in total** across the whole response (not per item). Items are processed in order; JSON records are truncated at the remaining budget and the affected item is flagged `truncatedToCeiling: true`. XML cannot be truncated safely: if the aggregate `<entry>` count would exceed 1,000, the whole response is rejected with `RESPONSE_INVALID`.
- **Cursors:** per-item continuation cursors work exactly like `query_entity` cursors (same signed envelope, same binding rules, replay with the same environment, entityPath and options). A cursor produced by a `batch_get` item can be replayed in another `batch_get` item or in `query_entity` with identical arguments.
- **Auth:** Basic or OAuth per environment, exactly like `query_entity`. An OAuth 401 on the batch POST invalidates the cached token and replays the **whole batch exactly once** (safe: every embedded operation is a GET); Basic 401 does not retry.

## Limitations & MVP scope

- OData **v2 only**; OData v4 is deferred until a tenant with a verified v4 endpoint exists.
- Optional **`entityAllowlist`** (see [Configuration](#entity-allowlist-optional)): without it, reads are bounded by the tenant account's permissions.
- **No function imports / custom service operations** (rejected with `FUNCTION_IMPORT_UNSUPPORTED`).
- **No writes of any kind**: no POST/PUT/PATCH/DELETE/MERGE from tool input, no method-tunneling headers (there is no input surface for headers at all). The single sanctioned POST is `batch_get`'s fixed GET-only `$batch` envelope (plus the two fixed OAuth token endpoints); nothing else can produce a POST.
- Cursor-based continuation (`cursor`), `inlinecount` totals, `output: "xml"` and `batch_get` (max 180 items, 1,000 total records) are implemented.
- **Basic Auth or OAuth 2.0** per environment, over HTTPS only.
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

[MIT](LICENSE) — Copyright (c) 2026 ChipTime. Published on npm as
[`ssff-mcp`](https://www.npmjs.com/package/ssff-mcp).
