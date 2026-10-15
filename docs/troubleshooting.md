# Troubleshooting

> Part of [ssff-mcp](../README.md). Error codes you may see in a tool result and
> how to fix them.

Every tool error is a sanitized object `{ code, message }` (plus optional
`httpStatus`). The `message` never contains secrets, URLs or raw service bodies.

| Code | Meaning / fix |
|---|---|
| `CONFIG_MISSING` | No `config.json` and inline mode not configured. Run `ssff-mcp init`, copy the template, or set `SF_*`. |
| `CONFIG_INVALID` | The config failed strict validation (unknown key, bad URL, bad allowlist, non-null `defaultEnvironment`, …). The message names the field. |
| `CONFIG_SECRET_MISSING` | A `fromEnv` secret provider referenced a variable that is not set or is empty. |
| `CONFIG_SECRET_COMMAND_FAILED` | A `fromCommand` secret provider failed or produced empty output. |
| `CONFIG_SECRET_TIMEOUT` | A `fromCommand` secret provider exceeded the 5s timeout. |
| `ENVIRONMENT_REQUIRED` | The call omitted `environment`. Only inline mode may omit it. |
| `ENVIRONMENT_UNKNOWN` | The named environment is not configured. The server never falls back to another one. |
| `ENTITY_NOT_ALLOWED` | Blocked by [`entityAllowlist`](configuration.md#entity-allowlist). |
| `PATH_INVALID` | Bad `entityPath`, unknown entity set, or a rejected `$`-segment. |
| `OPTION_INVALID` | Bad or conflicting option (e.g. `skip` + `cursor`, `asOfDate` + `fromDate`, listing options with `entitySet`, control characters, malformed dates). |
| `CURSOR_INVALID` | Cursor altered, reused with different arguments, or issued before a server restart. Re-run the query. |
| `FUNCTION_IMPORT_UNSUPPORTED` | The path is a function import; not supported. |
| `RESOURCE_NOT_FOUND` | Unknown entity in a resource / `inspect_entity`. |
| `METADATA_UNAVAILABLE` | The `$metadata` could not be fetched or parsed. |
| `RESPONSE_TOO_LARGE` | Above the [size cap](configuration.md#response-size-cap); narrow with `$select`/`$top`/`$filter`. |
| `RESPONSE_INVALID` | Unparseable service body, or XML above the 1,000-entry ceiling. |
| `REDIRECT_BLOCKED` | A redirect to a non-configured host was blocked. |
| `TIMEOUT` | The request exceeded the tool timeout. |
| `NETWORK_ERROR` | Transport-level failure (sanitized; no hostnames). |
| `HTTP_ERROR` | The service returned a non-2xx status (sanitized). |
| `OAUTH_ASSERTION_ERROR` / `OAUTH_TOKEN_ERROR` | OAuth assertion/token issues. Check the IP whitelist and credentials. |
| `BATCH_INVALID` | The `$batch` envelope could not be built or parsed. |
| `INTERNAL_ERROR` | Unexpected internal error (details intentionally hidden). |

## Common symptoms

- **A filtered query returns unfiltered-looking data.** Use the tools rather
  than hand-built URLs: the server always sends literal `$` option names, which
  SuccessFactors requires. This is handled for you inside `query_entity` and
  `batch_get`.
- **A cursor stopped working after restarting the server.** Expected: cursors are
  valid only for the life of the process. Re-run the original query to get a
  fresh cursor.
- **`CONFIG_INVALID: defaultEnvironment`.** Set `defaultEnvironment` to `null` or
  remove it — implicit environment selection is forbidden.
- **Windows: a permissions warning on every call.** It is emitted once per
  process; restrict the config with ACLs to silence it permanently.
- **An effective-dated read returns 404.** Pass `fromDate`/`toDate` (or
  `asOfDate`) — without the window, a historical key lookup answers 404.
