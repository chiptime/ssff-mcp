# Tools & Resources

> Part of [ssff-mcp](../README.md). The five tools, the MCP resources, and the
> query semantics that apply to all reads.

Everything the server exposes is **read-only**: no tool can write, and there is
no input surface for HTTP methods or headers. Data reads dispatch exactly one
`HTTPS GET` per call; the only `POST` is the fixed, GET-only `$batch` envelope
used by `batch_get`.

## Tools

Names, descriptions and argument tables below are **generated** from
`src/tool-catalog.ts`; run `pnpm docs:gen` after changing a tool.

<!-- START GENERATED: tools -->
### `list_environments`

_List configured environments._

Lists the environments configured for this server (aliases and auth type only; no URLs or credentials). Takes no arguments.

No arguments.

### `inspect_entity`

_Inspect the data model._

Reads the data model from the cached $metadata; no data request is made. Without entitySet it lists entities as { name, isCustom }; customOnly narrows to Custom MDF objects (adding isEffectiveDated, linkType, targetEntity, matchField, plus employeeLinkedCount), employeeLinkedOnly narrows that list further to the ones tied to a User or EmpEmployment, and query filters names by substring. With entitySet it returns that entity's schema; Custom MDF entities also carry isCustom, isEffectiveDated, employeeLink and query guidance (suggested $filter, $orderby, warnings, and a ready query_entity example). Always query a custom entity as the root with $filter and $top; expanding it from User returns the whole child collection. locale selects the language of the guidance prose (the user's language, e.g. es_ES).

| Argument | Type | Required | Description |
|---|---|---|---|
| `environment` | string | no | Required; must be a configured alias. Optional in inline mode (a single configured environment). |
| `entitySet` | string | no | Entity set to detail (e.g. 'User', 'cust_EmployeeEquipment'). If omitted, lists entities. |
| `customOnly` | boolean | no | When listing, keep only Custom MDF objects and add their classification fields. Default: false. |
| `employeeLinkedOnly` | boolean | no | When listing Custom MDF objects, keep only those tied to a User or EmpEmployment. Requires customOnly. |
| `query` | string | no | When listing, keep entities whose name contains this text (case-insensitive). |
| `locale` | string | no | Locale for the guidance text, normally the user's own language (e.g. 'es_ES'). It takes precedence over config defaultLocale, SF_DEFAULT_LOCALE and the 'en_US' fallback. |

### `resolve_picklist`

_Resolve or search picklist options and labels._

Resolves picklist option IDs to readable labels, lists options of a picklist, or searches options by label to assist in building $filter queries. optionId: resolves a numeric legacy ID (e.g. '10283'). picklistId: lists active options for that catalog (e.g. 'maritalStatus', 'gender'). externalCode: looks up an option by its business code (e.g. 'M', 'FULL_TIME'). query: searches labels by text and returns matching optionId and suggestedFilter (e.g. 'Casado' -> 'maritalStatus eq 10119'). locale: preferred language for labels (e.g. 'es_ES', 'en_US'). forceRefresh: when true, refreshes the local cache from SuccessFactors.

| Argument | Type | Required | Description |
|---|---|---|---|
| `environment` | string | no | Required; must be a configured alias. Optional in inline mode (a single configured environment). |
| `picklistId` | string | no | Identificador de la picklist (ej. 'gender', 'maritalStatus'). |
| `optionId` | string \| number | no | Option ID numérico de SAP (ej. '10283' o 10283). |
| `externalCode` | string | no | Código externo de negocio (ej. 'M', 'FULL_TIME'). |
| `query` | string | no | Texto libre o etiqueta a buscar para traducción inversa (ej. 'Casado', 'Masculino'). |
| `locale` | string | no | Código de idioma (ej. 'es_ES', 'en_US'). Por defecto usa el configurado globalmente (`defaultLocale`), si existe. |
| `forceRefresh` | boolean | no | Si es true, ignora la caché local y consulta directamente a SAP. |

### `query_entity`

_Query OData v2 entity data._

Reads entity data from SAP SuccessFactors OData v2 for the selected environment. entityPath examples: "User", "User('123')", "Foobar(key1='a',key2=1)/navProperty". Options map 1:1 to OData system query options and their values pass through unmodified: filter -> $filter, orderby -> $orderby, select -> $select, expand -> $expand, top -> $top, skip -> $skip, inlinecount -> $inlinecount (allpages only). The configured entityAllowlist/entityDenylist is enforced on the first path segment AND on every navigation destination, including every $expand route: a hop whose target entity set is not permitted fails with ENTITY_NOT_ALLOWED, a hop the metadata does not model fails with NAVIGATION_NOT_ALLOWED, and an $expand the server cannot fully parse (including $filter or $orderby nested inside it) fails with OPTION_INVALID instead of being dispatched unverified. An allowlist entry may also carry fields: the properties that entity exposes (its keys are always readable). References to a property outside that list fail with ENTITY_NOT_ALLOWED, the returned records are redacted to the permitted properties, and when fields apply the xml output is downgraded to JSON with outputDowngraded: true. Effective dating: fromDate, toDate and asOfDate (bare YYYY-MM-DD, NOT $-prefixed; SuccessFactors ignores the $-prefixed forms) select the effective-dated slices; asOfDate is exclusive and cannot be combined with fromDate or toDate. Ceiling: at most 1000 records and exactly one OData page are returned per call; next links are never followed automatically (hasMore indicates a next page exists). Continuation: when hasMore is true the response may carry an opaque cursor; to fetch the exact next page, re-issue the SAME call (same environment, entityPath and options) passing that cursor as the cursor argument. The cursor is a signed envelope tied to this server process: it is rejected (CURSOR_INVALID) when altered, reused with different arguments, or after a server restart; skip cannot be combined with cursor. inlinecount "allpages" returns totalCount when the service provides __count. output selects the representation: "json" (default, unwrapped records) or "xml" (raw service XML body, hasMore/totalCount/cursor reported in structuredContent).

| Argument | Type | Required | Description |
|---|---|---|---|
| `environment` | string | no | Required; must be a configured alias. Optional in inline mode (a single configured environment). |
| `entityPath` | string | yes | Resource path: an entity set, an entity by key, or a bounded navigation. Examples: `User`, `User('123')`, `Foobar(key1='a',key2=1)/navProperty`. Max 4 segments and 512 chars; `$`-prefixed segments are rejected. |
| `filter` | string | no | Raw OData value, passed through unmodified (`$filter`). |
| `orderby` | string | no | Raw OData value, passed through unmodified (`$orderby`). |
| `select` | string | no | Raw OData value, passed through unmodified (`$select`). |
| `expand` | string | no | Raw OData value, passed through unmodified (`$expand`). |
| `fromDate` | string | no | Effective-dating window start, format YYYY-MM-DD. Sent as the bare fromDate query parameter (not $-prefixed). Cannot be combined with asOfDate. |
| `toDate` | string | no | Effective-dating window end, format YYYY-MM-DD. Sent as the bare toDate query parameter (not $-prefixed). Cannot be combined with asOfDate. |
| `asOfDate` | string | no | Effective-dating point in time, format YYYY-MM-DD. Sent as the bare asOfDate query parameter (not $-prefixed). Cannot be combined with fromDate or toDate. |
| `top` | number | no | `$top`: integer >= 1. Above 1000 it is clamped to 1000 and flagged (`topClamped`). |
| `skip` | number | no | `$skip`: integer 0..1,000,000. Cannot be combined with `cursor`. |
| `cursor` | string | no | Continuation cursor from a previous response. Repeat the SAME environment, entityPath and options of the call that produced it and pass the cursor to fetch the exact next page. Rejected (CURSOR_INVALID) if altered, reused with different arguments, or after a server restart. Cannot be combined with skip. |
| `inlinecount` | "allpages" | no | Adds $inlinecount=allpages; the response includes totalCount when the service provides __count. |
| `resolvePicklists` | boolean | no | Cuando es true, enriquece automáticamente los campos asociados a picklists añadiendo las etiquetas legibles en la propiedad _picklistLabels sin modificar los valores nativos. |
| `locale` | string | no | Idioma preferido para las etiquetas (ej. 'es_ES', 'en_US'). Si se omite, utiliza el locale configurado globalmente (`defaultLocale`), si existe. |
| `output` | "json" \| "xml" | no | Response representation: "json" (default, unwrapped records) or "xml" (raw service XML body). |

### `batch_get`

_Batch multiple OData v2 GETs (read-only $batch)._

Executes multiple read-only OData v2 GETs against the selected environment in ONE $batch POST. Each item uses exactly the query_entity GET grammar (entityPath plus optional filter, orderby, select, expand, fromDate, toDate, asOfDate, top, skip, cursor, inlinecount); there is no field for HTTP method, URL, host, headers, body or changesets, and unknown keys are rejected before dispatch. fromDate, toDate and asOfDate are bare YYYY-MM-DD effective-dating options (NOT $-prefixed); asOfDate is exclusive and cannot be combined with fromDate or toDate. Hard limits: 1 to 180 items per call (SAP $batch limit) and at most 1000 records returned in TOTAL across all items; items are processed in input order and truncated records are flagged (truncatedToCeiling) when the aggregate ceiling is hit. Every item is fully validated BEFORE the batch is dispatched (path grammar, entity allowlist, option bounds, cursor binding, $metadata classification): one invalid item rejects the whole batch with no $batch POST issued (a metadata GET for classification is the only allowed call). The entityAllowlist/entityDenylist is enforced per item on the first path segment AND on every navigation destination, including every $expand route; one denied, unresolvable or unparseable item rejects the whole batch before the POST. Allowlist entries may carry fields (permitted properties, keys always readable): an item referencing a non-permitted property rejects the batch, records are redacted, and when fields apply the xml output is downgraded to JSON with outputDowngraded: true per item. The response contains one entry per item in input order with per-item status: { index, path, success, httpStatus, recordCount, records|body, hasMore, cursor?, totalCount?, truncatedToCeiling? }; per-item failures carry a sanitized error, never the raw service body. output selects the representation for the whole call: "json" (default, unwrapped records) or "xml" (raw Atom item bodies, Accept: application/atom+xml). Continuation cursors work exactly like query_entity cursors and must be replayed with the same environment, entityPath and options.

| Argument | Type | Required | Description |
|---|---|---|---|
| `environment` | string | no | Required; must be a configured alias. Optional in inline mode (a single configured environment). |
| `requests` | array<object> | yes | Array of 1..180 items (SAP `$batch` hard limit). Each item uses exactly the `query_entity` GET grammar. There is no field for HTTP method, URL, host, headers, body or changesets. |
| `output` | "json" \| "xml" | no | Response representation for the whole call: "json" (default) or "xml" (raw Atom item bodies). |

<!-- END GENERATED: tools -->

## Query encoding and effective dating

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

## Pagination and continuation

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

## MCP resources

Read-only resources for inspecting the schema and catalog without spending a data
query. Resources take no parameters (so the guidance locale uses only
`defaultLocale` → `SF_DEFAULT_LOCALE` → `en_US`).

| Resource URI | Description |
|---|---|
| `sf://{environment}/overview` | Summary: `baseUrl`, `authType`, entity count, function imports count, `allowlistConfigured` and `denylistConfigured` for that environment. |
| `sf://{environment}/entities` | Lightweight catalog of entity **names** (`{ name }`), allowlist-filtered. |
| `sf://{environment}/entities/{entitySet}` | Exhaustive entity schema: keys, typed properties (`Edm.*`, nullable) and navigation properties with cardinality. For Custom MDF entities it also carries `isCustom`, `isEffectiveDated`, `employeeLink` and `guidance`. |
| `sf://{environment}/mdf/custom` | Compact catalog of the allowlisted Custom MDF (`cust_*`) entities: `totalCount`, `employeeLinkedCount`, and per entity `name`, `isEffectiveDated`, `linkType`, `targetEntity?`, `matchField?`. |

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

## Examples: what you ask, what happens

You drive the assistant in natural language; it picks the tool.

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
