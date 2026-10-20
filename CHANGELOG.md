# Changelog

All notable changes to this project are documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Reconstruction note (2026-10-14).** This file was created retrospectively from the
> repository history. The repository has **no git tags**, so the version boundaries below
> are inferred from the `chore: release <version>` commits. Entries before 0.3.0 are a
> best-effort summary; only 0.3.0 is a verbatim release record.

## [Unreleased]

### Added

- **`cache invalidate --tenant <id>`** for multi-tenant configs. The command now
  accepts `--tenant <id>` to invalidate one declared tenant's cached `$metadata`
  (`<alias|--all>` unchanged); a multi-tenant config without `--tenant` fails
  with the real cause plus the remediation hint, an unknown tenant is named in
  the error, and the command never resolves secrets (invalidation is
  local-only, FR-97). Single-tenant configs keep the previous behavior.

- **Hosted mode: `ssff-mcp serve` over Streamable HTTP** (FR-154..FR-164). One
  `/mcp` endpoint (POST/GET/DELETE) plus a public `GET /healthz`, no framework
  beyond `node:http`. Every request re-authenticates (`Authorization: Bearer` or
  `X-API-Key`), the presented key resolves a tenant **and** an environment scope,
  and each session is bound to the key, tenant and scope that opened it — another
  key cannot ride an existing session, not even inside the same tenant. Sessions
  are capped (`SSFF_MAX_SESSIONS`, default 50) and swept when idle
  (`SSFF_SESSION_IDLE_MS`, default 5 min) so vanished clients do not leak.
  `SIGTERM`/`SIGINT` drain in-flight work for up to 10 s. Host headers are checked
  against `SSFF_ALLOWED_HOSTS` (loopback only by default) and a browser `Origin`
  must match the request host. A non-empty `PORT` with no command selects HTTP;
  STDIO behavior is unchanged.
- **`ssff-mcp key hash`** (FR-170): reads one line from stdin and prints only the
  sha-256 digest, so a key never reaches argv, history or logs.
- **Official container image** (`Dockerfile`, FR-169): multi-stage, Node 22
  alpine, runs as the unprivileged `node` user, with a `/healthz` healthcheck.
  `.dockerignore` allowlists the build inputs, so no tenant config or `.env` can
  enter the build context. `config.hosted.template.json` documents the hosted
  file shape with placeholders that fail validation until replaced.
- **Hosting guide** (`docs/hosting.md`): Dokploy + TLS pilot path, mounted config
  and cache volumes, the key model, server settings, and connection examples for
  OpenCode, Codex, VS Code/Copilot, Claude Desktop, Pi and agy — with their
  unverified limitations stated explicitly.

### Changed

- **Every tenant boundary is now explicit** (FR-160/FR-161/FR-166). Environment
  listings and resources only expose aliases the presented key may use. OAuth
  token caches are keyed by tenant, alias and credential identity instead of the
  bare alias, and the shared `lastExpiresInSeconds` race is gone. Continuation
  cursors are bound to the tenant as well as the alias, path and options. The
  response-size cap is resolved per request instead of mutating process-global
  state. A key hash matching several tenants/environments is denied instead of
  picking one.
- Metadata cache file names now escape the separator inside each component, so
  `("a-b", "c")` and `("a", "b-c")` can no longer collide.

### Fixed

- **Tenant resolution for the hosted mode** (`src/tenancy.ts`): keys are stored
  as sha-256 digests and compared in constant time; an environment key reaches
  only its environment, a tenant key reaches all of them, and unknown or absent
  keys resolve to nothing (fail-closed, never a default tenant). Not wired to
  any transport yet.

### Changed

- **The `$metadata` disk cache is namespaced by tenant.** Cache files move from
  `metadata-<alias>.json` to `metadata-<tenant>-<alias>.json` (the flat shape
  and inline mode use the `default` namespace), so two tenants sharing an alias
  can never share an entry — in memory or on disk. `ssff-mcp cache invalidate`
  deletes the tenant-scoped file. Existing cache files under the old name are
  ignored (delete them manually if you care); the first call after upgrading
  refetches `$metadata` once per environment.

## [0.5.0] — 2026-10-18

### Added

- **Multi-tenant config shape: `tenants.<id>`.** The config accepts a tenants level where
  each tenant carries its own environments, tenant-level allowlist/denylist defaults and
  hashed API keys; a per-environment list **replaces** (never merges) the tenant-level one.
  The flat legacy shape keeps working and resolves as a single `default` tenant, with a
  one-time migration warning. stdio resolves exactly one tenant; two or more are rejected,
  pointing at the future serve mode.
- **Field-level granularity: `fields` on each `entityAllowlist` entry.**
  `{ "entity": "User", "fields": ["userId", "firstName"] }` restricts the properties that
  entity exposes. Absent or `[]` means every property, exactly like the entity list itself.
  The entity's **keys are always readable** (added implicitly), so `__metadata.uri` never
  leaks a denied property and every record stays referenceable. Enforcement is complete:
  references to a non-permitted property in `$select`, `$filter`, `$orderby` — including
  `navProp/property` paths, which are checked against the entity the path reaches — and in
  `$select` inside `$expand` fail with `ENTITY_NOT_ALLOWED`; the **response payload is
  redacted** (without this, omitting `$select` would return every property); expanded records
  are redacted with their own entity's `fields`; and `inspect_entity` plus the
  `sf://{env}/entities/{entitySet}` resource hide non-permitted properties from the schema —
  if you cannot read it, you cannot discover it. `fields` is rejected on `entityDenylist`:
  a property denylist would add a second, ambiguous precedence rule.
- **`output: "xml"` is downgraded when `fields` apply.** Redacting Atom means rewriting
  namespaces, `m:properties`, `m:null` and nested entries; instead the response comes back as
  JSON with `outputDowngraded: true`. SuccessFactors Atom is also 2–3× the tokens of the same
  JSON, so the downgrade is the cheaper answer for the model. XML is untouched when no
  `fields` are configured.

### Fixed

- **The advertised version is no longer hardcoded.** The outgoing `User-Agent` and the MCP
  server handshake both reported `0.1.0` — two releases stale, and wrong to the SuccessFactors
  tenant receiving every request. Both now read the version from the shipped `package.json`
  (`src/version.ts`), so a release bump propagates on its own, and the tests derive the
  expected value from the manifest instead of pinning a literal.
- **The `User-Agent` claimed to run on `linux` on every OS.** macOS and Windows tenants saw
  `linux` on every request they received. The string is now built from `process.platform`, so
  it reports `darwin`, `win32` or `linux` truthfully. On Linux the header is byte-for-byte
  unchanged.

## [0.4.0] — 2026-10-17

### Breaking

- **`entityAllowlist` is now per environment.** The key moves inside each
  environment (`environments.<alias>.entityAllowlist`) so one environment can be restricted
  while another is not; a single shared list could not express that. A **top-level
  `entityAllowlist` is now rejected** with `CONFIG_INVALID` naming the field and the fix —
  move each list into the environment it applies to. `SF_ENTITY_ALLOWLIST` now populates the
  single environment synthesized in inline mode. The shipped `config.template.json` no longer
  carries the key, which restores the documented promise that copying the template never
  activates a restriction silently.
- **An empty `entityAllowlist` no longer denies everything.** `[]` now narrows nothing,
  exactly like an absent list: the allowlist only subtracts from what the tenant account can
  already read. This entry documents the **final** semantics — no published version ever
  carried the previous `[]` = deny-all rule, so there is nothing to migrate on top of the key
  move above.
- **Navigation and `$expand` are now filtered, and unverifiable values are rejected.** Both
  used to bypass the lists entirely: a navigation segment names a NavigationProperty, so
  `User('x')/payrollNav` reached `Payroll` without ever being checked, and `$expand` was passed
  through verbatim. Every hop is now resolved to its **target entity set** and checked with the
  same precedence. Consequences to expect: a navigation the metadata does not model fails with
  `NAVIGATION_NOT_ALLOWED`, and an `$expand` the server cannot fully parse — including
  `$filter`/`$orderby` nested inside it — fails with `OPTION_INVALID` instead of being
  dispatched unverified.
- **Entity paths reject URL-structural syntax.** `validateEntityPath` now refuses `%`, `#`,
  `?`, `\` and `.`/`..` path segments with `PATH_INVALID`. Those characters are interpreted
  **after** validation — by URL normalisation and by SuccessFactors — so a path validated as
  `User` could be dispatched as another entity set: `User('x/../Payroll#')` collapsed to
  `/odata/v2/Payroll` while the allowlist had only ever seen `User`. A key that legitimately
  needs a quote keeps using OData's doubled-quote escaping (`''`).
- **A denied entity is unreachable through any query option.** `$filter`, `$orderby` and
  `$select` are scanned by identifier: a `navProp/field` path is walked hop by hop, and a bare
  name is rejected when it is an association of the queried entity. A `$select` inside
  `$expand` is checked against the expanded entity. That closes three surfaces:
  `$select=empInfo` used to return a `__deferred` link naming a denied entity, a bare
  `$filter=empInfo ne null` made SuccessFactors answer 500, and `expand=job($select=manager)`
  named a denied association. Scalar properties pass untouched.
- **New `entityDenylist` per environment** (`SF_ENTITY_DENYLIST` in inline mode). Precedence
  is **denylist > allowlist > the API account's own permissions**. There is no wildcard:
  deny-all is expressed by listing the entities to remove. It also exists for the layered
  model, where an environment subtracts from a base inherited at tenant level.
- **`sf://{env}/overview` no longer reports `allowlistDeniedAll`**, which would now always be
  `false`. It reports `denylistConfigured` instead, and `allowlistConfigured` is `false` for
  an empty list.

### Added

- **Unified `inspect_entity` tool.** A single tool to inspect the data model, standard or
  custom. Without `entitySet` it lists entities as `{ name, isCustom }` (`customOnly` narrows
  to Custom MDF objects and adds their classification, `employeeLinkedOnly` keeps only those
  tied to `User`/`EmpEmployment`, `query` filters names by substring); with `entitySet` it
  returns that entity's schema, adding `isCustom`, `isEffectiveDated`, `employeeLink` and
  guidance for Custom MDF entities. It **replaces `inspect_custom_mdf`** (never released):
  the model keeps exactly **four tools** — `list_environments`, `inspect_entity`,
  `query_entity`, `batch_get`.
- **Custom MDF discovery** (`archive/PRD-feature-custom-mdf.md`, D-62..D-70). `cust_*` objects
  are classified from the cached `$metadata` (no data request) into six employee-link types,
  effective-dated objects are flagged, and an object carries guidance with a ready
  `query_entity` example. Surfaced through `inspect_entity` and the resource
  `sf://{env}/mdf/custom`; `sf://{env}/entities/{entitySet}` gains `isCustom`,
  `isEffectiveDated`, `employeeLink` and `guidance` for Custom MDF entities only (additive;
  other entities are unchanged).
- **`defaultLocale`** config field and `SF_DEFAULT_LOCALE`. Guidance prose is emitted in a
  single language chosen by `locale` argument > `defaultLocale` > `SF_DEFAULT_LOCALE` > `en_US`
  (catalogs: `en_US`, `es_ES`).
- **`ssff-mcp cache invalidate <alias|--all>` CLI** (D-78/D-79). Drops the cached `$metadata`
  of one environment or all of them. It never touches SuccessFactors (no network); the running
  server notices on its next metadata read. Exit codes: `0` success, `1` config unreadable,
  `2` usage error (unknown alias deletes nothing).
- **Configurable response size cap** (D-75/FR-86): `maxResponseBytes` in `config.json`, then
  `SF_MAX_RESPONSE_BYTES`, then the **256 KiB** default. Results above the cap fail with the
  new `RESPONSE_TOO_LARGE` code and an actionable message; `batch_get` applies it per inner
  request.
- **Effective-dating query options.** `query_entity` and `batch_get` accept optional
  `fromDate`, `toDate` and `asOfDate` (`YYYY-MM-DD`). They are sent as **bare** query
  parameters, because SuccessFactors silently ignores the `$`-prefixed forms and falls
  back to the currently active slice. They are valid on collection reads and on
  key-predicate reads, and are bound into the continuation cursor.
  Employee Central effective-dated entities need them: without the window, a historical
  `EmpJob` key lookup answers **404** and `EmpJob`/`PerPersonal` return only the active
  slice. `asOfDate` is mutually exclusive with `fromDate`/`toDate`.
- **OData v2 typed literals in key predicates.** The entity-path grammar now accepts a
  case-insensitive type prefix (`datetimeoffset`, `datetime`, `time`, `guid`, `binary`,
  `X`, `decimal`, `float`, `double`) before a quoted string, the `true`/`false`/`null`
  literals, and the numeric type suffixes `L`, `f`, `F`, `d`, `D`, `m`, `M`, so real
  composite keys such as
  `PaymentInformationDetailV3(PaymentInformationV3_effectiveStartDate=datetime'2013-01-01T00:00:00',PaymentInformationV3_worker='1000001',externalCode=860259L)`
  validate instead of being rejected with `PATH_INVALID`.
- **Opt-in integration smoke test** covering the document, bank-certificate and
  other-requirements catalog plus the effective-dating scenarios against a real tenant
  (`SSFF_MCP_INTEGRATION=1`). It is skipped, never failed, without credentials.

### Changed

- **`sf://{env}/entities` is now a names-only catalog** (`{ name }`). The heavier fields
  (`entityType`, `keyProperties` and the custom/effective-dated/employee flags) were dropped
  from the catalog to cut its size (measured 142 KB → ~19 KB on a 658-entity tenant); they
  remain in the per-entity resource `sf://{env}/entities/{entitySet}` and in
  `sf://{env}/mdf/custom`.
- `sf://{env}/mdf/custom` and the `list` of resource templates include the new items above.
  Clients that pin the exact list of tools or resources will see `inspect_entity` and
  `sf://{env}/mdf/custom`.
- **CI and packaging.** `pnpm build` cleans `dist/` before every build, so stale artifacts
  can neither run locally nor ship in the package. A GitHub Actions matrix now typechecks
  and tests on Linux, macOS and Windows with Node 20.

### Fixed

- **`ssff-mcp init` wrote the allowlist at the top level**, which the server now rejects: the
  wizard would have generated a config it refuses to load. It now writes the allowlist inside
  the generated environment.
- **`ssff-mcp init` silently ignored an empty allowlist selection.** Answering "Restrict
  access with an entity allowlist?" and then selecting nothing produced a config with **no**
  restriction at all, inverting the user's choice without a warning. The wizard now asks again
  until at least one entity is picked (or the user cancels) — necessary because an empty
  allowlist narrows nothing. A tenant that exposes no entity sets is reported honestly as
  staying unrestricted.
- **Filtered queries and `orderby` no longer lose their spaces.** Option values for
  `$filter`, `$orderby`, `$select` and `$expand` were assembled through
  `URLSearchParams`, which encodes a space as `+` and percent-encodes quotes, commas and
  parentheses; SuccessFactors answers **400** to both. They are now assembled by raw
  concatenation with spaces encoded uniformly as `%20`, preserving every other character
  literally. See `archive/PRD-feature-odata-query-fidelity.md` (M1/FR-77).
- **Batch inner requests keep literal `$` option names.** A `%24`-prefixed option name is
  matched verbatim by the `$batch` parser and therefore **silently ignored**, so the part
  returned unfiltered data (measured: 1000 default rows instead of the filtered one). The
  previous blind `%24 → $` rewrite is gone; the query is embedded exactly as built.
- The Windows config-permission warning is emitted once per process instead of repeating on
  every tool call.

### Security

- Control characters (CR, LF, NUL) in `filter`, `orderby`, `select` and `expand` are
  rejected with `OPTION_INVALID` before any dispatch, since they could inject extra HTTP
  request lines into the `$batch` multipart envelope. The error never echoes the value.
- Added regression tests for secret redaction and the POSIX-only permission check.

### Documentation

- Rebuilt the documentation: the **README is now a hub** (badges, a "How it
  works" diagram, an ask/answer demo, a documentation index and per-client blocks)
  and the deep reference moved to `docs/` — `configuration`, `tools`, `security`,
  `troubleshooting`, `faq` and `development`.
- The tools reference in `docs/tools.md` is **generated** from
  `src/tool-catalog.ts` (single source for tool names, titles, descriptions and
  input schemas) via `pnpm docs:gen`; `test/docs-tools-sync.test.ts` fails when the
  committed document drifts.
- Implemented PRDs moved to `archive/` (indexed in `archive/README.md`); the
  repository root keeps only the pending ones.

## [0.3.0] — 2026-10-14

### Breaking

- **Removed the `get_metadata` tool.** It returned the raw OData v2 `$metadata` XML
  document (≈7.5 MB) to the model, and it was the only code path that bypassed the
  metadata cache (D-43/D-44), forcing a fresh download on every call.
  **Migration:** read the schema from the `sf://{env}/entities` catalog resource or the
  `sf://{env}/entities/{entitySet}` resource instead. Both read through the cache and
  apply the `entityAllowlist`.
  See `archive/PRD-feature-remove-get-metadata.md` (D-76/D-77).

### Changed

- Every metadata path visible to the model is now allowlist-filtered. The previous
  `$metadata` allowlist exemption (FR-28/D-15) is now **vacuous**, because no unfiltered
  metadata path remains.

### Documentation

- Added feature PRDs for custom MDF objects, picklists, OData v4 evaluation and
  pre-packaged HR prompts.
- Added the PRD for removing `get_metadata`, which amends `PRD.md` FR-04 and resolves
  assumption A-1.
- Documented production-verified OData query patterns and a response size guard scoped
  to LLM-bound output.
- Ignore local code-intelligence and agent-diagnostics artifacts (`.codegraph/`,
  `.agy-diagnostics/`).

## [0.2.0] — 2026-10-13

### Added

- **Phase 3:** secret providers, MCP Resources (environment overview, entity catalog and
  per-entity schema), cross-platform cache paths and permission handling.
- **Phase 4:** interactive `init` onboarding wizard with per-client templates (Codex,
  Pi, OpenCode, Claude Desktop, Cursor).

## [0.1.1] — 2026-10-07

### Changed

- Published-status README and npm package prepared under the MIT license.

## [0.1.2] — 2026-10-07

### Fixed

- `npx` wiring pinned to `latest`.

## [0.1.0] — 2026-09-30 (and the 0.1.x line up to 0.2.0)

> Boundaries in this range are inferred; see the reconstruction note above.

### Added

- Read-only MCP server for SAP SuccessFactors OData v2 over **STDIO**.
- Tools: `list_environments`, `get_metadata`, `query_entity`, `batch_get`.
- Per-user configuration at `~/.config/ssff-mcp/config.json`, sanitized errors and
  metadata-only logging.
- GET-only dispatch enforcement with a pagination ceiling.
- Basic Auth, plus OAuth 2.0 SAML-bearer assertion via the SAP IdP helper.
- Stateless cursor continuation, `$inlinecount` and XML output for `query_entity`.
- Optional fail-closed `entityAllowlist` enforcement.
- GET-only `batch_get` built on the `odata-batch` retrieve pattern.

[Unreleased]: https://github.com/chiptime/ssff-mcp/compare/0.5.0...HEAD
[0.5.0]: https://github.com/chiptime/ssff-mcp/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/chiptime/ssff-mcp/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/chiptime/ssff-mcp/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/chiptime/ssff-mcp/releases/tag/0.2.0
