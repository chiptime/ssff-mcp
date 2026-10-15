# Development

> Part of [ssff-mcp](../README.md). Build, test, project layout and how to
> contribute.

## Requirements

- Node.js >= 20
- pnpm

## Build and test

```bash
pnpm install
pnpm build          # cleans dist, then runs tsc
pnpm test           # builds, then runs node --test dist/test/
pnpm typecheck      # tsc --noEmit
pnpm docs:gen       # regenerates the tools section of docs/tools.md
```

The negative suite is the point: write-shape rejection before dispatch,
fail-closed environment handling, redirect blocking, error sanitization, the
pagination ceiling and log-field allowlists are all covered by automated tests.

### Generated documentation

`docs/tools.md`'s tools section is generated from `src/tool-catalog.ts` (the
single source of the tool names, titles, descriptions and schemas). After
changing a tool, run `pnpm docs:gen`; `test/docs-tools-sync.test.ts` fails if the
committed document drifts.

### Opt-in integration test

`test/odata-query-fidelity.integration.test.ts` runs the query-fidelity scenarios
(encoding, key-predicate grammar, effective dating) against a **real** tenant
through the real MCP tool path. It is opt-in:

```bash
SSFF_MCP_INTEGRATION=1 pnpm test
```

Without `SSFF_MCP_INTEGRATION=1` it is skipped — and it is skipped (never failed)
when your real `~/.config/ssff-mcp/config.json` cannot be loaded or has no
`TEST_basic` environment. It prints no secrets: only the environment alias,
record counts, HTTP statuses and sanitized error codes.

## Project layout

| Path | Contents |
|---|---|
| `src/index.ts` | CLI entry point: STDIO server, `init`, `cache invalidate`, `--help`. |
| `src/tools.ts` | MCP server assembly: tools registered from the catalog, resources, logging. |
| `src/tool-catalog.ts` | Single source of the tool definitions (name, title, description, schema). |
| `src/tool-doc.ts` | Renders the tools reference for `docs/tools.md`. |
| `src/config.ts` | Config loading, strict validation, secret providers, inline mode. |
| `src/odata.ts` | Query assembly, key-predicate grammar, effective dating, paging. |
| `src/batch.ts` | The GET-only `$batch` envelope. |
| `src/metadata.ts` | `$metadata` fetch, parse and cache. |
| `src/mdf.ts` | Custom MDF (`cust_*`) classification. |
| `src/http.ts`, `src/oauth.ts` | HTTP dispatch and OAuth 2.0. |
| `src/cli/` | The `init` wizard and its client-block generators. |

## Versioning and releases

The project follows [Semantic Versioning](https://semver.org). Delivered changes
are recorded in [CHANGELOG.md](../CHANGELOG.md). Design documents for pending
work live in the repository root (`PRD-feature-*.md`); completed ones are in
[`archive/`](../archive).

## Contributing

Issues and pull requests are welcome at
[chiptime/ssff-mcp](https://github.com/chiptime/ssff-mcp). Please keep the
read-only guarantee intact: this server must never gain the ability to write to
SuccessFactors. Add tests with behavior changes, and run `pnpm test` plus
`pnpm docs:gen` before opening a PR.

## Maintainers

[@chiptime](https://github.com/chiptime).
