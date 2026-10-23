# Archived PRDs

These documents specify work that has already been **implemented and verified**
(or deliberately retired). They are kept for historical traceability only: they
do **not** describe pending work.

Open / pending PRDs live in the repository root (`PRD-feature-*.md`).

| Document | Status | What shipped |
|---|---|---|
| `PRD.md` | Executed | Phase 1 MVP: read-only OData v2 STDIO server, `query_entity`, config, Basic auth, pagination ceiling. |
| `PRD-phase2.md` | Executed | Phase 2: cursor continuation, `$inlinecount`, XML output, `batch_get`, OAuth 2.0, `entityAllowlist`. |
| `PRD-phase3.md` | Executed | Phase 3: MCP resources, cross-platform cache paths, secret providers, disk metadata cache. |
| `PRD-phase3-handoff.md` | Executed | Phase 3 continuation: remaining items closed and published. |
| `PRD-phase4.md` | Executed | Phase 4: interactive `init` wizard with per-client blocks (Codex, Pi, OpenCode, Claude Desktop, Cursor). |
| `PRD-feature-custom-mdf.md` | Executed | Custom MDF (`cust_*`) discovery, six link types, effective-dating flag, guidance prose, `defaultLocale`. |
| `PRD-feature-odata-query-fidelity.md` | Executed | Raw query assembly (`%20` spaces), typed key-predicate literals, bare `fromDate`/`toDate`/`asOfDate`. |
| `PRD-feature-metadata-cache-invalidation.md` | Executed | `ssff-mcp cache invalidate <alias\|--all>` CLI. |
| `PRD-feature-inspect-entity.md` | Executed | Unified `inspect_entity` tool (replaced `inspect_custom_mdf`). |
| `PRD-feature-remove-get-metadata.md` | Executed | Removal of the `get_metadata` tool (released in 0.3.0). |
| `PRD-feature-datacenter-catalog.md` | Executed | Preloaded SAP SuccessFactors data centers catalog (`src/datacenters.ts`), API server resolution, init wizard prompts. |

References between these documents resolve inside this folder (for example
`PRD-phase3.md` from `PRD-phase3-handoff.md`). PRD files still in the repository
root point to their archived dependencies with an explicit `archive/` prefix.
