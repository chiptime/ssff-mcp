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

- **Custom MDF discovery** (`PRD-feature-custom-mdf.md`, D-62..D-70). New tool
  `inspect_custom_mdf` and resource `sf://{env}/mdf/custom` classify `cust_*` objects
  from the cached `$metadata` (no data request) into six employee-link types, flag
  effective-dated objects, and return `queryGuidance` with a ready `query_entity` example.
  `sf://{env}/entities` gains `isEmployeeLinked` / `isEffectiveDated`, and
  `sf://{env}/entities/{entitySet}` gains `isCustom`, `isEffectiveDated`, `employeeLink`
  and `guidance` for Custom MDF entities only (additive; other entities are unchanged).
- **`defaultLocale`** config field and `SF_DEFAULT_LOCALE`. Guidance prose is emitted in a
  single language chosen by `locale` argument > `defaultLocale` > `SF_DEFAULT_LOCALE` > `en_US`
  (catalogs: `en_US`, `es_ES`).
- **Response size cap** (D-75/FR-86): results returned to the model are limited to 256 KiB.
  Larger ones fail with the new `RESPONSE_TOO_LARGE` code and an actionable message;
  `batch_get` applies it per inner request.

### Changed

- `sf://{env}/entities` and `list` of resource templates include the new items above. Clients
  that pin the exact list of tools or resources will see `inspect_custom_mdf` and
  `sf://{env}/mdf/custom`.

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

[0.3.0]: https://github.com/chiptime/ssff-mcp/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/chiptime/ssff-mcp/releases/tag/0.2.0
