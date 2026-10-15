# ssff-mcp

A local, **read-only** MCP (Model Context Protocol) server for **SAP
SuccessFactors OData v2**. It lets an AI assistant (OpenCode, Claude Desktop,
Cursor, Codex, Pi, or any MCP client) read your SuccessFactors data — safely,
one page at a time, and without any possibility of writing.

The server talks to the MCP client over **STDIO** only (no HTTP port anywhere)
and dispatches data reads as `HTTPS GET`, exactly one fetch per call. The single
sanctioned `POST` is the fixed, GET-only `$batch` envelope used by `batch_get`
(plus the two fixed OAuth token endpoints). The read-only frontier lives in
server code, never in a prompt.

- **Tools:** `list_environments`, `inspect_entity`, `query_entity`, `batch_get`
- **Resources:** environment overview, entity catalog, per-entity schema, Custom
  MDF catalog
- **Auth:** Basic or OAuth 2.0, per environment, over HTTPS only
- **Platforms:** Linux, macOS, Windows
- **License:** MIT

> **Release status.** The published npm version is **0.3.0**. The
> `inspect_entity` tool, the `ssff-mcp cache invalidate` command, the
> configurable response-size cap and the Custom MDF improvements are on `main`
> and land in the next release. If you need them today, run from source (see
> [Install](#install)).

---

## What is this?

`ssff-mcp` is a small bridge between an AI assistant and SAP SuccessFactors. The
assistant asks MCP questions ("which environments are configured?", "list the
entities", "read `User` filtered by …"); the server validates every request,
enforces your local rules, and returns only the data you allowed.

You get:

- A **safe** way to let a model read SF data: read-only by construction, with a
  hard pagination ceiling, a response-size cap and sanitized errors.
- **Several ways to ask:** a data model inspector, a single-entity query tool
  with `$filter/$orderby/$select/$expand/$top/$skip` and effective dating, and a
  batch tool that packs up to 180 reads into one request.
- **MCP resources** for browsing the schema without spending a data query.
- **Your choice of credentials:** a config file, or inline environment variables
  injected by the client (no file at all).

It is a **local** server: you run it on your machine, with your credentials, and
nothing is proxied through a third party.

---

## Requirements

- **Node.js >= 20** (Linux, macOS, Windows).
- **pnpm** — only if you develop from source. The installed CLI needs nothing
  beyond Node.

---

## Install

### From npm (recommended)

Run it on demand with `npx`:

```bash
npx -y ssff-mcp@latest
```

Or install it globally and call `ssff-mcp`:

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

---

## Quick start

Three steps, about five minutes.

**1. Run the configuration wizard.** It asks for your tenant URL and
credentials, validates them live against `$metadata`, optionally lets you pick an
entity allowlist, writes `~/.config/ssff-mcp/config.json`, and prints the block
to paste into your MCP client.

```bash
npx -y ssff-mcp@latest init
```

**2. Paste the printed block** into your client's config (see
[Connecting your MCP client](#connecting-your-mcp-client)).

**3. Restart the client and ask it something**, for example:

> "List my SuccessFactors environments."
> "Inspect the `User` entity and tell me its key and main fields."
> "Read the first 5 `PerPersonal` rows for user `1000001`."

The assistant will call the matching tool and answer from the real data.

> Prefer no config file at all? Use [inline mode](#inline-mode-no-config-file)
> and put `SF_*` environment variables straight into the client block.

---

## Connecting your MCP client

The server is a local stdio MCP server, so each client launches it as a
subprocess. The wizard prints the exact block for the client you pick. The five
supported shapes are below (with the configuration file holding your
credentials, so the block itself carries no secrets).

| Client | Config file | Format |
|---|---|---|
| OpenCode | `opencode.json` | JSON |
| Claude Desktop | `claude_desktop_config.json` | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Pi | `~/.pi/agent/mcp.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |

**OpenCode** (`opencode.json`):

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

**Claude Desktop / Cursor / Pi**:

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

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.ssff-mcp]
command = "npx"
args = ["-y", "ssff-mcp@latest"]
```

For the inline mode (credentials in the block, no config file), the `env` /
`environment` object carries the `SF_*` variables instead of being empty. Secret
variables are referenced, not embedded, by the generator.

---

## Configuration

The configuration file lives at a **fixed** path:

- **Linux / macOS:** `~/.config/ssff-mcp/config.json`
- **Windows:** `%USERPROFILE%\.config\ssff-mcp\config.json`

`XDG_CONFIG_HOME` is deliberately **not** honored. The file is re-read and
re-validated on **every tool call** (the server is stateless), so you can edit it
without restarting. Secrets are never logged and never written elsewhere.

### Manual setup

1. Create the directory: `mkdir -p ~/.config/ssff-mcp` (Windows:
   `mkdir "%USERPROFILE%\.config\ssff-mcp"`).
2. Copy the template shipped in the package:

   ```bash
   cp "$(npm root -g)/ssff-mcp/config.template.json" ~/.config/ssff-mcp/config.json
   ```

   (adjust the path for a non-global install, or grab `config.template.json`
   from the repository).
3. Fill in the placeholders.
4. Restrict permissions: `chmod 600 ~/.config/ssff-mcp/config.json` on POSIX.
   On Windows, restrict access with ACLs (`icacls`). The server warns on stderr
   (once) if the file is readable by others.

### Full example

```json
{
  "environments": {
    "prod": {
      "baseUrl": "https://api4.successfactors.com",
      "auth": {
        "type": "basic",
        "username": "integration@mycompany",
        "password": { "fromEnv": "SF_PROD_PASSWORD" }
      }
    },
    "staging": {
      "baseUrl": "https://custom-staging.example.com/api",
      "auth": {
        "type": "oauth",
        "clientId": "<oauth-client-api-key>",
        "companyId": "mycompany",
        "userId": "sf_api_user",
        "privateKey": { "fromCommand": ["op", "read", "op://Personal/sf-key/key"] },
        "tokenUrl": "https://api4.successfactors.com/oauth/token"
      }
    }
  },
  "entityAllowlist": [
    { "entity": "User" },
    { "entity": "PerPersonal" },
    { "entity": "EmpJob", "protocols": ["v2"] }
  ],
  "defaultLocale": "es_ES",
  "maxResponseBytes": 262144
}
```

### Fields

| Field | Required | Meaning |
|---|---|---|
| `environments` | Yes | Object; may be empty. Keys are environment aliases you choose (for example `prod`, `staging`). |
| `environments.<alias>.baseUrl` | Yes | Tenant API origin, for example `https://api4.successfactors.com`. Must be `https`, with no credentials/userinfo, no query string and no fragment. A path prefix is allowed. **Do not append `/odata/v2`** — the server adds it. |
| `environments.<alias>.auth` | Yes | `{"type":"basic", …}` or `{"type":"oauth", …}` (see below). |
| `defaultEnvironment` | No | If present it **MUST be `null`**. Implicit environment selection is forbidden; any non-null value is rejected. |
| `entityAllowlist` | No | Array of `{ entity, protocols? }`. Restricts what `query_entity` and the metadata resources may read. See [Entity allowlist](#entity-allowlist). |
| `defaultLocale` | No | Preferred language for Custom MDF guidance prose, for example `"es"` or `"es_ES"` (`-` also accepted). Only the format is validated; an untranslated language falls back to `en_US`. See [Guidance language](#guidance-language). |
| `maxResponseBytes` | No | Optional cap, in bytes, for what a single tool call returns to the model. Positive integer. Takes precedence over `SF_MAX_RESPONSE_BYTES`; default **256 KiB**. See [Response size cap](#response-size-cap). |

The configuration object is **strict**: unknown keys are rejected with
`CONFIG_INVALID`. A missing file is only an error if inline mode is not
configured — the server starts anyway and reports `CONFIG_MISSING` on the first
call.

### Authentication

**Basic Auth** (`auth.type: "basic"`):

| Field | Meaning |
|---|---|
| `username` | API username. SuccessFactors API users are often of the form `user@companyId`. |
| `password` | API password. A plain string, or a [secret provider](#secret-providers). |

**OAuth 2.0** (`auth.type: "oauth"`) — grant
`urn:ietf:params:oauth:grant-type:saml2-bearer` via SAP's IdP helper (no local
SAML signing, no extra dependencies):

| Field | Meaning |
|---|---|
| `clientId` | OAuth2 client **API key** from Manage OAuth2 Client Applications in SF Admin Center. |
| `companyId` | Tenant company id; sent as `company_id` to the token endpoint. |
| `userId` | Technical user id **WITHOUT** the `@companyId` suffix (values containing `@` are rejected). |
| `privateKey` | Private key **exactly as exported/stored** (a single line; may be a composite `<base64>/<base64>`). Paste it verbatim: never decode, re-encode or retype it. A plain string or a secret provider. |
| `tokenUrl` | Fixed token endpoint, e.g. `https://<host>/oauth/token`. Must be `https` and match exactly what SAP expects (SAP embeds it in the assertion audience). |
| `idpUrl` | Optional. SAP IdP helper endpoint; defaults to the `tokenUrl` origin + `/oauth/idp`. |

Flow (automatic, per call when needed): `POST {idpUrl}` with
`{client_id, user_id, token_url, private_key}` returns a signed SAML assertion;
`POST {tokenUrl}` with `{client_id, grant_type, company_id, assertion}` returns
the bearer token (`expires_in` ≈ 24h). Tokens are cached **in memory per
environment only**, refreshed with a 60s / 10% safety margin, and a 401 on a data
read triggers exactly one invalidation + retry. These two POSTs are the only
non-GET requests the server can ever issue.

> **Prerequisite:** the client machine's IP must be whitelisted in SF Admin
> Center (Password & Login Policy Settings → API login exceptions) or the token
> endpoints reject the connection.

### Secret providers

Any password or OAuth private key can be a plain string or resolved dynamically,
so you never have to put the secret on disk:

```json
{ "fromEnv": "SF_PROD_PASSWORD" }
{ "fromCommand": ["op", "read", "op://Personal/sf-key/key"] }
```

`fromCommand` is executed directly via `execFile` (no shell) with a 5s timeout.

### Entity allowlist

`entityAllowlist` restricts which entity sets `query_entity` may read. It is a
local, explicit scope control **on top of** the tenant account's permissions.

| Field | Meaning |
|---|---|
| `entity` | OData entity set name (`^[A-Za-z_][A-Za-z0-9_]*$`), matched case-sensitively and exactly against the **first** path segment. |
| `protocols` | Optional array of `"v2"` and/or `"v4"`, without duplicates. Omitted means both protocols. This build is v2-only, so an entry that excludes `"v2"` is **denied**. |

Semantics:

- **Absent** — no restriction; every entity the account can read is reachable.
- **Present** — only the listed entities are queryable; anything else is
  rejected with `ENTITY_NOT_ALLOWED` before any network request (not even
  `$metadata` is fetched for a denied query).
- **`[]` (empty array)** — configured deny-all: every `query_entity` call is
  rejected. Deliberate fail-closed behavior.
- **Navigation** — only the first path segment is checked; segments after it
  (`User('123')/navProperty`) are not re-checked.
- **Metadata is filtered too** — the entity catalog, the per-entity schema
  resource and `inspect_entity` apply the allowlist exactly like a data read.

The key is deliberately **not** in `config.template.json`: a copied template must
not silently activate an allowlist. Invalid allowlists are rejected with
`CONFIG_INVALID`.

### Inline mode (no config file)

If `~/.config/ssff-mcp/config.json` does **not** exist, the server can synthesize
a single environment from `SF_*` environment variables injected by your MCP
client:

| Variable | Meaning |
|---|---|
| `SF_BASE_URL` | Tenant API origin (required to enable inline mode). |
| `SF_USERNAME`, `SF_PASSWORD` | Basic auth credentials. |
| `SF_CLIENT_ID`, `SF_COMPANY_ID`, `SF_USER_ID`, `SF_TOKEN_URL`, `SF_PRIVATE_KEY` | OAuth 2.0 credentials (`SF_PRIVATE_KEY` accepts `\n` escapes or base64). |
| `SF_IDP_URL` | Optional OAuth IdP helper endpoint. |
| `SF_ENVIRONMENT` | Environment alias (default: `default`). |
| `SF_ENTITY_ALLOWLIST` | Comma-separated entity allowlist, e.g. `User,PerPersonal,EmpJob`. |
| `SF_DEFAULT_LOCALE` | Language of the Custom MDF guidance text, e.g. `es_ES`. |
| `SF_MAX_RESPONSE_BYTES` | Response-size cap, in bytes (a configured `maxResponseBytes` wins). |

In inline mode a tool call may omit `environment` (there is exactly one). If a
`config.json` **exists**, it always wins and the `SF_*` variables are ignored
with a warning on stderr.

### Guidance language

The Custom MDF guidance prose is written in **one** language per response, never
several. The first value present wins:

`locale` argument of the call (the user's language) > `defaultLocale` in
`config.json` > `SF_DEFAULT_LOCALE` > `en_US`.

Available catalogs: **`en_US`, `es_ES`**. The language used is reported in
`guidance.locale`. `$filter` templates, the example query and OData identifiers
are never translated.

### Response size cap

What a single call returns to the model is limited to **256 KiB** of text by
default. A larger result is rejected with `RESPONSE_TOO_LARGE` and an actionable
message ("narrow it with `$select`, `$top`, `$filter`, no collection
`$expand`"). The cap is purely size-based and never consults an entity list.
Metadata used internally for classification and caching is exempt. In
`batch_get` it applies to **each inner request** separately: an oversized item
fails alone and the others are returned normally.

Override it with `maxResponseBytes` in `config.json` (wins), then
`SF_MAX_RESPONSE_BYTES`, then the 256 KiB default.

---

## CLI reference

```
ssff-mcp                                    Start the MCP server over STDIO (default)
ssff-mcp init                               Run the interactive configuration wizard
ssff-mcp cache invalidate <alias|--all>     Drop cached $metadata for an environment
ssff-mcp --help                             Show help
```

- **`init`** — interactive wizard (auth type, live validation, optional
  filterable allowlist, atomic write with mode `0600` and a `.bak` backup). It
  requires an interactive terminal; a non-TTY run exits with code `2`.
- **`cache invalidate`** — deletes the cached `$metadata` of one alias, or all of
  them with `--all`. It never touches SuccessFactors (no network). The running
  server notices on its next metadata read. Exit codes: `0` success, `1` config
  unreadable, `2` usage error (unknown alias deletes nothing — fail-closed).

---

## Examples: what you ask, what happens

You drive the assistant in natural language; it picks the tool. These are the
shapes a good assistant will use.

| You ask | Tool used | What happens |
|---|---|---|
| "Which SuccessFactors environments do I have configured?" | `list_environments` | Returns `{ environments: [{ alias, authType }] }`. No network. |
| "What entities can I read?" | `inspect_entity` (no `entitySet`) | Lists `{ name, isCustom }` from the cached `$metadata`; no data request. |
| "Show me the custom MDF objects linked to employees." | `inspect_entity` with `customOnly: true, employeeLinkedOnly: true` | Filtered catalog with `isEffectiveDated`, `linkType`, `targetEntity`, `matchField`. |
| "Give me the schema of `EmpJob`." | `inspect_entity` with `entitySet` | Keys, typed properties (nullable) and navigation properties with cardinality. |
| "Read the current job info for employee `1000001`." | `query_entity` | One GET, e.g. `filter: "userId eq '1000001'"`, `top: 5`. |
| "Find users whose last name is García, only id, name and email." | `query_entity` | `filter`, `select`, `top`. |
| "Read the job history for employee `1000001` over 2024." | `query_entity` | `filter` + `fromDate`/`toDate` (bare effective-dating params). |
| "Fetch these five entities at once: …" | `batch_get` | One GET-only `$batch` POST, up to 180 items, results in input order. |
| "Get the next page." | `query_entity` | Re-issue the same call with the `cursor` from the previous response. |

Example — a filtered query with selected fields and a page size:

```json
{
  "environment": "prod",
  "entityPath": "PerPersonal",
  "filter": "userId eq '1000001'",
  "select": "userId,firstName,lastName",
  "top": 5
}
```

Example — a batch of independent reads in one POST:

```json
{
  "environment": "prod",
  "requests": [
    { "entityPath": "User('1000001')" },
    { "entityPath": "EmpJob", "filter": "userId eq '1000001'", "top": 5 },
    { "entityPath": "PerPersonal", "filter": "userId eq '1000001'", "top": 5 }
  ]
}
```

---

## Tools reference

### `list_environments` (no arguments)

Returns `{ environments: [{ alias, authType }] }` — aliases and auth type only.
No URLs, no credentials, no network access.

### `inspect_entity` — read the data model

Reads the model from the cached `$metadata`; **no data request** is made.

| Argument | Constraints |
|---|---|
| `environment` | Required; must be a configured alias. Optional in [inline mode](#inline-mode-no-config-file). |
| `entitySet` | Optional. The entity to detail (standard or custom). When omitted, `inspect_entity` lists entities. Unknown / non-existent names return `RESOURCE_NOT_FOUND`; names blocked by the allowlist return `ENTITY_NOT_ALLOWED`. |
| `customOnly` | Optional boolean. When listing, keep only Custom MDF (`cust_*`) objects and add their classification fields. Default `false`. |
| `employeeLinkedOnly` | Optional boolean. When listing, keep only Custom MDF objects tied to `User` or `EmpEmployment`. Requires `customOnly: true`. |
| `query` | Optional. When listing, keep entities whose name contains this text (case-insensitive). |
| `locale` | Optional. Language of the guidance text, normally the user's own (`es_ES`). Takes precedence over `defaultLocale` and `SF_DEFAULT_LOCALE`. |

Behavior:

- **Listing** (no `entitySet`): `{ environment, totalCount, entities }` with
  `entities: [{ name, isCustom }]`. With `customOnly: true`, each item also has
  `isEffectiveDated`, `linkType`, `targetEntity`, `matchField`, and the response
  adds `employeeLinkedCount` and `locale`. `customOnly`, `employeeLinkedOnly`
  and `query` only apply to the listing.
- **Single entity** (`entitySet`): the entity schema. Custom MDF entities also
  carry `isCustom`, `isEffectiveDated`, `employeeLink` and `guidance`
  (suggested `$filter`, `$orderby`, warnings and a ready `query_entity`
  example). With `entitySet`, the listing-only options
  (`customOnly`/`employeeLinkedOnly`/`query`) are rejected with `OPTION_INVALID`
  rather than silently ignored.

### `query_entity` — read entity data

| Argument | Maps to | Constraints |
|---|---|---|
| `environment` | — | Required; must be a configured alias. Optional in inline mode. |
| `entityPath` | resource path | Required. Examples: `User`, `User('123')`, `Foobar(key1='a',key2=1)/navProperty`. Max 4 segments, max 512 chars; `$`-prefixed segments (`$batch`, `$value`, `$count`) are rejected. The first segment must be a declared entity set (function imports are rejected). |
| `filter` | `$filter` | Raw value, passed through. |
| `orderby` | `$orderby` | Raw value, passed through. |
| `select` | `$select` | Raw value, passed through. |
| `expand` | `$expand` | Raw value, passed through. |
| `fromDate` | `fromDate` | Effective-dating window start, `YYYY-MM-DD`, sent **bare** (not `$fromDate`). Cannot be combined with `asOfDate`. |
| `toDate` | `toDate` | Effective-dating window end, `YYYY-MM-DD`, sent bare. |
| `asOfDate` | `asOfDate` | Effective-dating point in time, `YYYY-MM-DD`, sent bare. Mutually exclusive with `fromDate`/`toDate`. |
| `top` | `$top` | Integer >= 1. Above 1000 it is clamped to 1000 (`topClamped: true`). |
| `skip` | `$skip` | Integer 0..1,000,000. Cannot be combined with `cursor`. |
| `cursor` | `$skiptoken` | Opaque continuation cursor from a previous response. Must be replayed with the SAME environment, `entityPath` and options; otherwise `CURSOR_INVALID`. |
| `inlinecount` | `$inlinecount` | Only `"allpages"`. Adds `$inlinecount=allpages`; the response includes `totalCount` when the service returns `__count`. |
| `output` | — | `"json"` (default) or `"xml"` (raw service XML body, Atom, native fields, no normalization; the `<link rel="next">` href is stripped). |

Unknown option names are structurally impossible: the tool schema is typed and
strict, so there is no passthrough map.

Response (`structuredContent`, JSON):
`{ environment, path, recordCount, records, hasMore, topClamped?, truncatedToCeiling?, totalCount?, cursor? }`.
Records are preserved **verbatim** with native SuccessFactors fields
(`__metadata` kept).

### `batch_get` — many reads in one request

Executes multiple read-only OData v2 GETs in **one** `$batch` POST. The
multipart envelope is built exclusively by
[`odata-batch`](https://www.npmjs.com/package/odata-batch) 2.1.0's retrieve mode
(direct GET parts, no changesets), travels through a narrow transport that
validates it before dispatch (fixed `$batch` URL, expected boundary, every inner
line `GET … HTTP/1.1`, no changeset delimiter), and accepts only the outer
headers `Authorization`, `Accept`, `Content-Type` and `User-Agent`.

| Argument | Constraints |
|---|---|
| `environment` | Required; must be a configured alias. Optional in inline mode. |
| `requests` | Array of **1..180 items** (SAP `$batch` hard limit). Each item uses exactly the `query_entity` GET grammar: `entityPath` (required) plus optional `filter`, `orderby`, `select`, `expand`, `fromDate`, `toDate`, `asOfDate`, `top`, `skip`, `cursor`, `inlinecount`. There is **no field** for HTTP method, URL, host, headers, body or changesets; unknown keys are rejected by the strict schema before dispatch. |
| `output` | `"json"` (default) or `"xml"`, global for the whole call. |

Behavior:

- **Full preflight before the POST:** every item is validated (path grammar,
  allowlist, option bounds, cursor binding, `$metadata` classification) before
  the `$batch` POST is built. One invalid item rejects the whole batch; the only
  allowed pre-batch call is the `$metadata` classification GET.
- **One POST, one page per item:** pages are never followed or combined. Inner
  request lines carry literal `$` option names (`$filter`, `$top`, …) because a
  percent-encoded name (`%24filter`) is silently ignored by the service.
- **Per-item results in input order:**
  `{ index, path, success, httpStatus, recordCount, records|body, hasMore, cursor?, totalCount?, topClamped?, truncatedToCeiling? }`.
  Embedded non-2xx parts become sanitized per-item errors; the call still
  succeeds and raw embedded bodies are never returned.
- **Aggregate ceiling:** at most **1,000 records in total** across the whole
  response. JSON records are truncated at the remaining budget (the item is
  flagged `truncatedToCeiling: true`). XML cannot be truncated safely, so a
  response whose `<entry>` count would exceed 1,000 is rejected with
  `RESPONSE_INVALID`.
- **Auth:** identical to `query_entity`. An OAuth 401 on the batch POST
  invalidates the cached token and replays the whole batch exactly once (safe:
  every embedded operation is a GET). Basic 401 does not retry.

### Query encoding and effective dating

How `query_entity` and `batch_get` turn options into the request query string:

- **Raw assembly, spaces as `%20`.** `filter`, `orderby`, `select` and `expand`
  are assembled by raw concatenation. Only spaces are encoded (`%20`);
  single quotes, `+`, `,`, `/`, `(`, `)`, `:`, `=` and `;` are preserved
  literally (`URLSearchParams` produced `+`, which SuccessFactors rejects with
  400).
- **Control characters are rejected.** CR, LF or NUL in any of those four values
  is rejected with `OPTION_INVALID` before dispatch (they could inject request
  lines into the `$batch` envelope). The error never echoes the value.
- **`$skiptoken` stays opaque** and is percent-encoded so it round-trips
  byte-identically.
- **Effective dating.** `fromDate`, `toDate` and `asOfDate` are `YYYY-MM-DD` and
  sent **bare** — SuccessFactors silently ignores the `$`-prefixed forms.
  `asOfDate` is exclusive of `fromDate`/`toDate`. Effective dating is required to
  read historical HRIS rows: without the window, a historical `EmpJob` key
  lookup returns 404. The options are valid on collection reads and on
  key-predicate reads.

### Pagination and continuation

- **Ceiling:** at most **1,000 records** and exactly **one OData page** per call.
  Next links are never followed automatically and never returned; `hasMore`
  merely reports that a next page exists. A page with more than 1,000 records is
  truncated (`truncatedToCeiling: true`).
- **Continuation (cursor):** when `hasMore` is true **and** the service next link
  carries a `$skiptoken`, the response includes an opaque `cursor`. Re-issue the
  **same** call with that cursor to get the next page. The cursor is a
  stateless HMAC-SHA256-signed envelope bound to environment + entity path + the
  canonical query options. There is **no server-side storage and no TTL**; the
  HMAC secret is random per process, so **every cursor is invalidated when the
  server restarts** (just run a fresh query). An altered cursor, or one reused
  with different arguments, is rejected with `CURSOR_INVALID` before any network
  dispatch. Cursor errors never echo the token. `skip` and `cursor` are mutually
  exclusive.

---

## MCP resources

Read-only resources for inspecting the schema and catalog without spending a data
query. Resources take no parameters (so the guidance locale uses only
`defaultLocale` → `SF_DEFAULT_LOCALE` → `en_US`).

| Resource URI | Description |
|---|---|
| `sf://{environment}/overview` | Summary: `baseUrl`, `authType`, entity count, function imports count, allowlist status. |
| `sf://{environment}/entities` | Lightweight catalog of entity **names** (`{ name }`), allowlist-filtered. |
| `sf://{environment}/entities/{entitySet}` | Exhaustive entity schema: keys, typed properties (`Edm.*`, nullable) and navigation properties with cardinality. For Custom MDF entities it also carries `isCustom`, `isEffectiveDated`, `employeeLink` and `guidance`. |
| `sf://{environment}/mdf/custom` | Compact catalog of the allowlisted Custom MDF (`cust_*`) entities: `totalCount`, `employeeLinkedCount`, and per entity `name`, `isEffectiveDated`, `linkType`, `targetEntity?`, `matchField?`. |

---

## Custom MDF discovery

SuccessFactors Metadata Framework objects (`cust_*`) are classified **entirely
from the cached `$metadata`** — no data request. Audit navigations
(`createdByNav` / `lastModifiedByNav`) are ignored. The `linkType` tells you how
the object relates to an employee:

| `linkType` | Meaning |
|---|---|
| `DIRECT_USER_KEY` | The key (`externalCode` or `userId`) is the user, via its own `externalCodeNav` / `userIdNav`. |
| `DIRECT_EMPLOYMENT_KEY` | Same, targeting `EmpEmployment`. |
| `USER_FIELD_NAVIGATION` | Another field navigates to `User` (any name; the target entity is the signal). |
| `EMPLOYMENT_FIELD_NAVIGATION` | Same, targeting `EmpEmployment`. |
| `COMPOSITE_CHILD` | Key `cust_<Parent>_<field>` with an existing custom parent; no direct employee link. |
| `UNLINKED_STANDALONE` | No employee link (master data or catalog). |

An object is effective-dated (`isEffectiveDated`) when its key contains
`effectiveStartDate` or `mdfSystemEffectiveStartDate`.

`guidance` gives the suggested `$filter` (`externalCode eq '<userId>'`,
`userId eq '<userId>'` or `<navProp>/userId eq '<userId>'`), the `$orderby` for
effective-dated objects, warnings and a ready `query_entity` example. **Always
query a custom entity as the root**: expanding it from `User` returns the whole
child collection and cannot be bounded.

---

## Security & privacy

- **Read-only by construction.** No POST/PUT/PATCH/DELETE/MERGE can come from
  tool input, and there is no header input surface at all. The only sanctioned
  POST is the fixed, GET-only `$batch` envelope (plus the two fixed OAuth token
  endpoints).
- **HTTPS only.** Basic credentials are sent only over TLS; redirects are
  followed only to the same https host configured for the environment.
- **Least-privileged account.** This server enforces read-only client-side, but
  the tenant account is an acceptance condition: use a read-only,
  least-privileged API user. What the account can read, this server can read.
- **Errors are sanitized.** Errors returned to the model are `{ code, message }`
  (plus optional `httpStatus`) with URLs redacted and generic wording for network
  failures (no hostnames).
- **Logs are metadata-only, on stderr.** One JSON line per call:
  `{ ts, tool, environment, outcome, code?, durationMs, recordCount? }`. No URLs,
  no entity paths, no query values, no bodies, no credentials. stdout carries
  only the MCP protocol.
- **Secrets stay in memory.** OAuth tokens never touch disk, logs or error
  messages. Secrets in `config.json` are never cached elsewhere.
- **Metadata cache.** Parsed `$metadata` schemas are cached on disk under the OS
  cache directory with a 24h TTL (plus a 10-minute in-memory layer). No person
  records or sensitive data are ever cached.

Cache locations:

| OS | Path |
|---|---|
| Linux | `~/.cache/ssff-mcp` |
| macOS | `~/Library/Caches/ssff-mcp` |
| Windows | `%LOCALAPPDATA%\ssff-mcp\cache` |

---

## Limits & scope

- **OData v2 only.** OData v4 is deferred until a tenant with a verified v4
  endpoint exists.
- **No function imports / custom service operations** (`FUNCTION_IMPORT_UNSUPPORTED`).
- **No writes of any kind.**
- **One page per call**, 1,000-record ceiling, 256 KiB default response cap,
  cursor-based continuation.
- **Cross-platform STDIO only**; there is no HTTP listener anywhere in the
  server.

---

## Troubleshooting

Error codes you may see in a tool result:

| Code | Meaning / fix |
|---|---|
| `CONFIG_MISSING` | No `config.json` and inline mode not configured. Run `ssff-mcp init`, copy the template, or set `SF_*`. |
| `CONFIG_INVALID` | The config failed strict validation (unknown key, bad URL, bad allowlist, non-null `defaultEnvironment`, …). The message names the field. |
| `CONFIG_SECRET_MISSING` / `CONFIG_SECRET_COMMAND_FAILED` / `CONFIG_SECRET_TIMEOUT` | A `fromEnv` / `fromCommand` secret provider failed. |
| `ENVIRONMENT_REQUIRED` / `ENVIRONMENT_UNKNOWN` | The call omitted or named an unconfigured environment. Only inline mode may omit it. |
| `ENTITY_NOT_ALLOWED` | Blocked by `entityAllowlist`. |
| `PATH_INVALID` | Bad `entityPath`, unknown entity set, or a rejected `$`-segment. |
| `OPTION_INVALID` | Bad or conflicting option (e.g. `skip` + `cursor`, `asOfDate` + `fromDate`, listing options with `entitySet`, control characters). |
| `CURSOR_INVALID` | Cursor altered, reused with different arguments, or issued before a server restart. Re-run the query. |
| `FUNCTION_IMPORT_UNSUPPORTED` | The path is a function import; not supported. |
| `RESOURCE_NOT_FOUND` | Unknown entity in a resource / `inspect_entity`. |
| `RESPONSE_TOO_LARGE` | Above the size cap; narrow with `$select`/`$top`/`$filter`. |
| `RESPONSE_INVALID` | Unparseable service body, or XML above the 1,000-entry ceiling. |
| `REDIRECT_BLOCKED` | A redirect to a non-configured host was blocked. |
| `TIMEOUT` / `NETWORK_ERROR` / `HTTP_ERROR` | Transport-level failures (sanitized). |
| `OAUTH_*` | OAuth assertion/token issues (check IP whitelisting and credentials). |
| `INTERNAL_ERROR` | Unexpected internal error (details intentionally hidden). |

If a filtered query returns unfiltered-looking data, check that you are using the
tools (not hand-built URLs): the server always sends literal `$` option names,
which SuccessFactors requires.

---

## Development & testing

```bash
pnpm install
pnpm build          # cleans dist, then runs tsc
pnpm test           # builds, then runs node --test dist/test/
pnpm typecheck      # tsc --noEmit
```

The negative suite is the point: write-shape rejection before dispatch,
fail-closed environment handling, redirect blocking, error sanitization, the
pagination ceiling and log-field allowlists are all covered by automated tests.

### Opt-in integration test

`test/odata-query-fidelity.integration.test.ts` runs the query-fidelity
scenarios (encoding, key-predicate grammar, effective dating) against a **real**
tenant through the real MCP tool path. It is opt-in:

```bash
SSFF_MCP_INTEGRATION=1 pnpm test
```

Without `SSFF_MCP_INTEGRATION=1` it is skipped — and it is skipped (never
failed) when your real `~/.config/ssff-mcp/config.json` cannot be loaded or has
no `TEST_basic` environment. It prints no secrets: only the environment alias,
record counts, HTTP statuses and sanitized error codes.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 ChipTime. Published on npm as
[`ssff-mcp`](https://www.npmjs.com/package/ssff-mcp).
