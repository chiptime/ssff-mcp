# Security & privacy

> Part of [ssff-mcp](../README.md). The read-only guarantees, how secrets and
> logs are handled, and the scope limits.

## Read-only by construction

- **No writes of any kind.** No POST/PUT/PATCH/DELETE/MERGE can come from tool
  input, and there is no header input surface at all. The only sanctioned POST is
  the fixed, GET-only `$batch` envelope (plus the two fixed OAuth token
  endpoints).
- **One GET per call.** Data reads dispatch exactly one `HTTPS GET`; next links
  are never followed automatically.
- **HTTPS only.** Basic credentials are sent only over TLS; redirects are
  followed only to the same https host configured for the environment (otherwise
  `REDIRECT_BLOCKED`).

## Use a least-privileged account

This server enforces read-only behavior client-side, but the tenant account is an
acceptance condition: use a **read-only, least-privileged** API user. What the
account can read, this server can read. Verify the account's roles in the tenant.

## Errors and logs

- **Errors are sanitized.** Errors returned to the model are `{ code, message }`
  (plus optional `httpStatus`) with URLs redacted from service messages and
  generic wording for network failures (no hostnames).
- **Logs are metadata-only, on stderr.** One JSON line per call:
  `{ ts, tool, environment, outcome, code?, durationMs, recordCount? }`. No URLs,
  no entity paths, no query values, no bodies, no credentials. stdout carries
  only the MCP protocol.

## Secrets

- **Tokens stay in memory.** OAuth tokens never touch disk, logs or error
  messages, and die with the process.
- **Config secrets are read on demand.** Passwords and OAuth private keys can be
  plain text or resolved per call via [`fromEnv` / `fromCommand`](configuration.md#secret-providers).
- **File permissions.** Restrict `config.json` to owner-only (`chmod 600` on
  POSIX, ACLs on Windows). The server warns on stderr (once per process) when the
  file is readable by others.

## Metadata cache

Parsed `$metadata` schemas are cached on disk under the OS cache directory with a
**24h TTL**, plus a 10-minute in-memory layer. **No person records or sensitive
data are ever cached.** Force a reload with [`ssff-mcp cache invalidate`](configuration.md#cli).

| OS | Cache path |
|---|---|
| Linux | `~/.cache/ssff-mcp` |
| macOS | `~/Library/Caches/ssff-mcp` |
| Windows | `%LOCALAPPDATA%\ssff-mcp\cache` |

## Limits & scope

- **Entity allowlist/denylist scope.** `entityAllowlist` narrows and `entityDenylist`
  subtracts, per environment. Both are enforced on **direct entity access** (`query_entity`,
  `batch_get`, `inspect_entity` and the `sf://` resources) **and on navigation destinations**:
  every hop of a navigation path or of an `$expand` value is resolved to the entity set it
  points at and checked, and neither an unresolvable hop nor an unparseable `$expand` is ever
  dispatched. Entity paths also reject URL-structural syntax (`%`, `#`, `?`, `\` and `.`/`..`
  segments) with `PATH_INVALID`, because normalisation and service parsing happen **after**
  validation.   Every reference in `$filter`, `$orderby` and `$select` is extracted by identifier — a path is
  walked hop by hop, and a bare name is rejected when it is an association of that entity — and
  a `$select` inside `$expand` is checked against the expanded entity. **A denied entity is not
  nameable through any query option**, not even to obtain a `__deferred` link.
  **Field-level granularity:** an allowlist entry may carry `fields`, restricting the properties
  that entity exposes. The response payload is redacted to those properties (keys always
  readable), references to others are rejected, and the schema surfaces hide them. When
  `fields` apply, `output: "xml"` is downgraded to JSON with `outputDowngraded: true`, because
  redacting Atom reliably is not worth the tokens it saves. A configured field list whose
  schema cannot be resolved **refuses the read** (`ENTITY_NOT_ALLOWED`) instead of returning
  unredacted data.
  **Known gap, declared:** expression extraction in `$filter`/`$orderby` is deliberately
  conservative — quoted literals are skipped and recognized identifier paths are checked, but
  an unrecognized expression form is **not** checked and is left to the service. The allowlist
  is a hard boundary for direct access, navigation paths and `$expand`; it is not a full OData
  expression parser.
- **OData v2 only.** OData v4 is deferred until a tenant with a verified v4
  endpoint exists.
- **No function imports / custom service operations** (`FUNCTION_IMPORT_UNSUPPORTED`).
- **One page per call**, 1,000-record ceiling, 256 KiB default response cap,
  cursor-based continuation.
- **Cross-platform STDIO only**; there is no HTTP listener anywhere in the
  server.
