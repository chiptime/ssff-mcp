# Configuration

> Part of [ssff-mcp](../README.md). Everything the server reads from
> `~/.config/ssff-mcp/config.json`, plus inline mode.

## Path and permissions

The configuration file lives at a **fixed** path:

- **Linux / macOS:** `~/.config/ssff-mcp/config.json`
- **Windows:** `%USERPROFILE%\.config\ssff-mcp\config.json`

`XDG_CONFIG_HOME` is deliberately **not** honored. The file is re-read and
re-validated on **every tool call** (the server is stateless), so you can edit it
without restarting. Secrets are never logged and never written elsewhere.

## Manual setup

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

The **`init` wizard** (`npx -y ssff-mcp@latest init`) does all of this for you:
it validates credentials live, writes the file atomically with mode `0600` and a
`.bak` backup, and prints the client block. It requires an interactive terminal;
a non-TTY run exits with code `2`.

## Full example

```json
{
  "environments": {
    "prod": {
      "baseUrl": "https://api4.successfactors.com",
      "auth": {
        "type": "basic",
        "username": "integration@mycompany",
        "password": { "fromEnv": "SF_PROD_PASSWORD" }
      },
      "entityAllowlist": [
        { "entity": "User" },
        { "entity": "PerPersonal" },
        { "entity": "EmpJob", "protocols": ["v2"] }
      ]
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
  "defaultLocale": "es_ES",
  "maxResponseBytes": 262144
}
```

## Multi-tenant shape

Fixed named MCP users may also be declared under each tenant, independently of
the shared SSFF technical credentials. See [Local user configuration](local-auth-config.md),
[Token operations](token-operations.md), and [HTTPS hosting](local-users-hosting.md).
Legacy API keys and STDIO keep their existing behavior; roles apply to personal-token
HTTP access, not to the SSFF technical account or local STDIO.

The file accepts **two shapes**:

- **Flat (legacy):** `environments` at the root, as in the example above. It
  auto-migrates to a single tenant **`default`** (a warning is printed once);
  everything keeps working unchanged.
- **Tenants:** everything nests under `tenants.<id>`. This is the shape for
  `ssff-mcp serve` (multi-tenant hosting); in `stdio` it must declare exactly
  **one** tenant — two or more are rejected with `CONFIG_INVALID` pointing at
  `serve`. The HTTP edge authenticates each request and loads only the matching
  tenant slice; see [Hosting](hosting.md) for the mounted-file, TLS and key setup.

```json
{
  "tenants": {
    "acme": {
      "apiKeyHash": "64-hex sha-256 digest of the client-wide key",
      "entityAllowlist": [ { "entity": "User" }, { "entity": "EmpJob" } ],
      "entityDenylist":  [ { "entity": "PerPersonal" } ],
      "environments": {
        "dev":  { "baseUrl": "…", "auth": { "…": "…" }, "apiKeyHash": "…only reaches dev…" },
        "prod": { "baseUrl": "…", "auth": { "…": "…" } }
      }
    }
  },
  "defaultLocale": "es_ES",
  "maxResponseBytes": 262144
}
```

Semantics:

- **Lists — tenant base, environment override.** A tenant-level
  `entityAllowlist`/`entityDenylist` is the default for every environment; an
  environment's own list **replaces** it (never merges). Precedence inside an
  environment is unchanged: `denylist > allowlist > the API account's permissions`.
- **`apiKeyHash`** is the sha-256 hex digest of an API key, stored hashed
  (never in clear). At **tenant** level it reaches **all** the tenant's
  environments; at **environment** level it reaches **only that environment**.
  It is consumed by the hosted mode (`serve`) and ignored by `stdio`.
- **Combining both shapes** (`environments` and `tenants` at the root) is
  ambiguous and rejected.
- `defaultLocale` and `maxResponseBytes` stay **global** in both shapes.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `environments` | Yes | Object; may be empty. Keys are environment aliases you choose (for example `prod`, `staging`). |
| `environments.<alias>.baseUrl` | Yes | Tenant API origin, for example `https://api4.successfactors.com`. Must be `https`, with no credentials/userinfo, no query string and no fragment. A path prefix is allowed. **Do not append `/odata/v2`** — the server adds it. |
| `environments.<alias>.auth` | Yes | `{"type":"basic", …}` or `{"type":"oauth", …}` (see below). |
| `defaultEnvironment` | No | If present it **MUST be `null`**. Implicit environment selection is forbidden; any non-null value is rejected. |
| `environments.<alias>.entityAllowlist` | No | Array of `{ entity, protocols? }`. Narrows what this environment's `query_entity` and metadata resources may read. Absent **or empty** means no narrowing. See [Entity allowlist and denylist](#entity-allowlist-and-denylist). |
| `environments.<alias>.entityDenylist` | No | Array of `{ entity, protocols? }`. Entities always denied in this environment; **wins over the allowlist**. See [Entity allowlist and denylist](#entity-allowlist-and-denylist). |
| `defaultLocale` | No | Preferred language for Custom MDF guidance prose, for example `"es"` or `"es_ES"` (`-` also accepted). Only the format is validated; an untranslated language falls back to `en_US`. See [Guidance language](#guidance-language). |
| `maxResponseBytes` | No | Optional cap, in bytes, for what a single tool call returns to the model. Positive integer. Takes precedence over `SF_MAX_RESPONSE_BYTES`; default **256 KiB**. See [Response size cap](#response-size-cap). |

The configuration object is **strict**: unknown keys are rejected with
`CONFIG_INVALID`. A missing file is only an error if inline mode is not
configured — the server starts anyway and reports `CONFIG_MISSING` on the first
call.

## Authentication

Every tool call names its environment explicitly. Unknown or missing environment
⇒ the call is rejected (fail-closed); the server never picks an implicit
environment and never retries against another one. The only exception is
**inline mode**, where exactly one environment exists and `environment` may be
omitted.

### Basic Auth (`auth.type: "basic"`)

| Field | Meaning |
|---|---|
| `username` | API username. SuccessFactors API users are often of the form `user@companyId`. |
| `password` | API password. A plain string, or a [secret provider](#secret-providers). |

### OAuth 2.0 (`auth.type: "oauth"`)

Uses the grant `urn:ietf:params:oauth:grant-type:saml2-bearer` via SAP's IdP
helper (no local SAML signing, no extra dependencies):

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

## Secret providers

Any password or OAuth private key can be a plain string or resolved dynamically,
so you never have to put the secret on disk:

```json
{ "fromEnv": "SF_PROD_PASSWORD" }
{ "fromCommand": ["op", "read", "op://Personal/sf-key/key"] }
```

`fromCommand` is executed directly via `execFile` (no shell) with a 5s timeout.

## Entity allowlist and denylist

`entityAllowlist` **narrows** what that environment's `query_entity` may read; it
is a local, explicit scope control **on top of** the tenant account's
permissions. `entityDenylist` subtracts further and **always wins**. Both are
configured **inside each environment**, so one environment can be restricted
while another is not:

```json
{
  "environments": {
    "prod": {
      "baseUrl": "https://api4.successfactors.com",
      "auth": { "type": "basic", "username": "u", "password": "p" },
      "entityAllowlist": [{ "entity": "User" }, { "entity": "PerPersonal" }],
      "entityDenylist": [{ "entity": "PerPersonal" }]
    },
    "dev": {
      "baseUrl": "https://dev.example.com",
      "auth": { "type": "basic", "username": "u", "password": "p" }
    }
  }
}
```

A top-level `entityAllowlist` is **rejected** with `CONFIG_INVALID`: one shared
list cannot express per-environment scope. The message names the field and the
fix.

| Field | Meaning |
|---|---|
| `entity` | OData entity set name (`^[A-Za-z_][A-Za-z0-9_]*$`), matched case-sensitively and exactly against the **first** path segment. |
| `protocols` | Optional array of `"v2"` and/or `"v4"`, without duplicates. Omitted means both protocols. This build is v2-only, so an entry that excludes `"v2"` never applies. |
| `fields` | **Allowlist only.** Optional array of property names. Present (and non-empty) means the entity exposes only those properties — plus its keys, which are always readable. Absent or `[]` means every property. Rejected on `entityDenylist`. |

Semantics, per environment. **Precedence: denylist > allowlist > the API account's own permissions.**

- **`entityAllowlist` absent or `[]`** — no narrowing: every entity the account can read is
  reachable. An empty list is **not** a deny-all.
- **`entityAllowlist` non-empty** — only the listed entities are queryable; anything else is
  rejected with `ENTITY_NOT_ALLOWED` before any data request.
- **`entityDenylist`** — the listed entities are denied for **direct entity access and for
  navigation destinations**, even when the allowlist permits them (see `PerPersonal` in the
  example). There is **no wildcard**: deny everything by listing what you want gone.
- **Navigation and `$expand` are checked too.** Every hop is resolved to the entity set it
  points at — a navigation segment names a NavigationProperty, not an entity set — and the
  destination is checked against the same lists. A hop the metadata does not model fails with
  `NAVIGATION_NOT_ALLOWED`, and an `$expand` the server cannot fully parse fails with
  `OPTION_INVALID`; neither is ever dispatched. `$filter`/`$orderby` that reference navigation
  paths remain unfiltered.
- **Metadata is filtered too** — the entity catalog, the per-entity schema
  resource, `inspect_entity` and the `sf://` resources apply that environment's lists exactly
  like a data read.

**Field-level granularity.** An allowlist entry may carry `fields`, restricting the properties
that entity exposes:

```json
{ "entity": "User", "fields": ["userId", "firstName"] }
```

- Absent or `[]` means every property; a non-empty list narrows.
- The entity's **keys are always readable** (added implicitly), so `__metadata.uri` never leaks
  a denied property and every record stays referenceable.
- References to a non-permitted property — in `$select`, `$filter`, `$orderby` (including
  `navProp/property`, checked against the entity the path reaches) or `$select` inside
  `$expand` — fail with `ENTITY_NOT_ALLOWED`.
- The **response payload is redacted** to the permitted properties; expanded records use their
  own entity's `fields`. The schema surfaces (`inspect_entity`,
  `sf://{env}/entities/{entitySet}`) hide non-permitted properties.
- When `fields` apply, `output: "xml"` is **downgraded to JSON** with `outputDowngraded: true`
  in the response: redacting Atom reliably would cost more than the verbose format saves.

Using an empty value nowhere narrows anything, so an accidentally empty list
fails **open**, not closed — that is the documented model. The `init` wizard
therefore refuses to write an empty allowlist: it asks again until you pick at
least one entity or cancel.

The key is deliberately **not** in `config.template.json`: a copied template must
not silently activate a restriction. Invalid lists are rejected with
`CONFIG_INVALID`, naming the offending field (`entityAllowlist` or
`entityDenylist`).

## Inline mode (no config file)

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
| `SF_ENTITY_ALLOWLIST` | Comma-separated entity allowlist for the single synthesized environment, e.g. `User,PerPersonal,EmpJob`. |
| `SF_ENTITY_DENYLIST` | Comma-separated entity denylist for the single synthesized environment; wins over the allowlist. |
| `SF_DEFAULT_LOCALE` | Language of the Custom MDF guidance text, e.g. `es_ES`. |
| `SF_MAX_RESPONSE_BYTES` | Response-size cap, in bytes (a configured `maxResponseBytes` wins). |

In inline mode a tool call may omit `environment` (there is exactly one). If a
`config.json` **exists**, it always wins and the `SF_*` variables are ignored
with a warning on stderr.

## Guidance language

The Custom MDF guidance prose is written in **one** language per response, never
several. The first value present wins:

`locale` argument of the call (the user's language) > `defaultLocale` in
`config.json` > `SF_DEFAULT_LOCALE` > `en_US`.

Available catalogs: **`en_US`, `es_ES`**. The language used is reported in
`guidance.locale`. `$filter` templates, the example query and OData identifiers
are never translated.

## Response size cap

What a single call returns to the model is limited to **256 KiB** of text by
default. A larger result is rejected with `RESPONSE_TOO_LARGE` and an actionable
message ("narrow it with `$select`, `$top`, `$filter`, no collection
`$expand`"). The cap is purely size-based and never consults an entity list.
Metadata used internally for classification and caching is exempt. In
`batch_get` it applies to **each inner request** separately: an oversized item
fails alone and the others are returned normally.

Override it with `maxResponseBytes` in `config.json` (wins), then
`SF_MAX_RESPONSE_BYTES`, then the 256 KiB default.

## CLI

```
ssff-mcp                                    Start the MCP server over STDIO (default)
ssff-mcp init                               Run the interactive configuration wizard
ssff-mcp cache invalidate <alias|--all>     Drop cached $metadata and picklists for an environment
ssff-mcp cache invalidate <alias|--all> --tenant <id>
                                            Same, for one tenant of a multi-tenant config
ssff-mcp --help                             Show help
```

- **`cache invalidate`** deletes the cached `$metadata` and picklist caches (`picklists-*` files and granular directories) of one alias, or all of
  them with `--all`. It never touches SuccessFactors (no network); the running
  server notices on its next read. Exit codes: `0` success, `1` config
  unreadable, `2` usage error (unknown alias deletes nothing — fail-closed).
  A multi-tenant config requires `--tenant <id>` (the target tenant must be
  declared, otherwise the command fails naming it); secrets are never resolved
  by this command, so it works even when secret providers are unavailable.

## Picklist Caching & Resolution

For a comprehensive technical architecture guide, see [Picklists Architecture](picklists.md).

Picklists are cached in a two-tier hierarchy:
- **L1 In-Memory Cache**: 1 hour TTL (configurable, default 60 min).
- **L2 Disk Cache**: 24 hours TTL, stored under `~/.cache/ssff-mcp/` (mode `0700` dir / `0600` files).

### Lazy Loading & Granularity
To handle small picklists (e.g. 2 options) and large picklists (e.g. 15,000 zip codes or cost centers) efficiently without RAM bloat:
1. **SAP to Disk (Lazy Retrieval)**: Picklists are fetched on demand from SAP OData (`PicklistOption` or `PickListValueV2`) only when an entity field or query references them. Large picklists are paginated automatically (`__next`).
2. **Disk to Memory (Granular Loading)**: Picklists are stored granularly per picklist ID (`picklists-<alias>/<picklistId>.json`). When resolving values, only the requested picklists are loaded into RAM rather than deserializing an entire monolithic tenant cache.
3. **Invalidation**:
   - **CLI**: `ssff-mcp cache invalidate <alias>` removes both metadata and granular/monolithic picklist caches.
   - **Tool Parameter**: `resolve_picklist` accepts `forceRefresh: true` to bypass and refresh local cache for a specific picklist directly from SAP.
4. **On-Demand `<field>_NavLabels` (Option C)**:
   - When `resolvePicklists: true` is passed in `query_entity` or `batch_get` alongside `$expand=<fieldNav>`, the MCP intercepts and resolves the picklist locally without SAP join overhead.
   - Attaches `<field>_NavLabels` (e.g. `maritalStatus_NavLabels`) with minimal `{ optionId, label }` by default.
   - Dynamically grows to include `externalCode`, `order` or `picklistId` when requested via `$select`.
