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

[Unreleased]: https://github.com/chiptime/ssff-mcp/compare/0.3.0...HEAD
[0.3.0]: https://github.com/chiptime/ssff-mcp/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/chiptime/ssff-mcp/releases/tag/0.2.0
