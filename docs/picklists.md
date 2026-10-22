# Picklists Resolution & Caching Architecture

This document provides a technical guide to the picklists resolution and caching subsystem in `ssff-mcp`.

---

## 1. Context & Motivation

In SAP SuccessFactors, enumerated fields (such as Gender, Marital Status, Country, Event Reasons, Cost Centers) are represented as **Picklists**. SuccessFactors uses two architectures:

1. **Legacy Picklists**: Entities like `PerPersonal` expose a numeric foreign key `id` (e.g., `gender = "10283"`), resolving to `PicklistOption` with nested `picklistLabels`.
2. **MDF Picklists (Metadata Framework)**: Modern entities reference a `PickListValueV2` with `externalCode` (e.g., `"M"` or `"DEF"`).

### The Problem
* **Raw Queries**: A query to `PerPersonal` returns opaque identifiers (`"10283"`, `"10119"`). Consuming LLMs and human operators cannot interpret these values without manual lookup.
* **Overhead of `$expand`**: Querying `PerPersonal?$expand=genderNav/picklistLabels` executes heavy database joins on SAP's backend, inflates response sizes by 3x–5x, and requires navigation properties to be explicitly allowlisted in `entityAllowlist`.
* **Scale Disparity**: Picklists range from 2 records (e.g., boolean flags or gender) to over **15,000 records** (e.g., zip codes, municipal districts, or cost center hierarchies).

### The Solution
`ssff-mcp` implements a **hybrid client-side caching and resolution engine** that:
* Transparently enriches query records with localized labels in under **5 ms** for 1,000 records.
* **Preserves both `optionId` and `label`** non-destructively.
* Implements a **lazy, granular two-tier cache (RAM + Disk)** preventing memory bloat.
* Provides a standalone inspection tool (`resolve_picklist`).
* Maintains 100% backward compatibility with OData `$expand`.

---

## 2. Retention of `optionId` and `label` (Non-Destructive Enrichment)

A core requirement is that downstream integrations, mutations, and filter predicates frequently require the **exact numeric `optionId`** or `externalCode` (e.g., `gender eq '10283'`).

When `resolvePicklists: true` is passed to `query_entity` or `batch_get`:
1. The **native record properties are NEVER overwritten**. `record.gender` remains `"10283"`.
2. A separate companion property **`_picklistLabels`** is attached to each record containing the full resolution tuple:

```json
{
  "personIdExternal": "cgranados",
  "gender": "10283",
  "maritalStatus": "10119",
  "_picklistLabels": {
    "gender": {
      "label": "Masculino",
      "optionId": "10283",
      "externalCode": "M",
      "picklistId": "gender",
      "resolved": true
    },
    "maritalStatus": {
      "label": "Casado/a",
      "optionId": "10119",
      "externalCode": "M",
      "picklistId": "maritalStatus",
      "resolved": true
    }
  }
}
```

If an orphan option or unmapped value is encountered, resolution fails safely without throwing:
```json
{
  "gender": "99999",
  "_picklistLabels": {
    "gender": {
      "resolved": false,
      "rawValue": "99999",
      "reason": "OPTION_NOT_FOUND"
    }
  }
}
```

---

## 3. Two-Tier Granular Caching Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                      MCP Server Runtime                       │
│                                                               │
│   query_entity / resolve_picklist                             │
│         │                                                     │
│         ▼                                                     │
│   ┌───────────────┐        Hit (< 1ms)                        │
│   │   L1: RAM     │─────────────────────────► Record Enricher │
│   │ (Map per opt) │                                           │
│   └───────┬───────┘                                           │
│           │ Miss                                              │
│           ▼                                                   │
│   ┌───────────────┐        Hit (< 5ms)                        │
│   │   L2: Disk    │─────────────────────────► Load into RAM   │
│   │ (~/.cache/...)│                                           │
│   └───────┬───────┘                                           │
│           │ Miss / Expired                                    │
│           ▼                                                   │
│   ┌───────────────┐        OData v2 GET                       │
│   │ SAP SF Cloud  │─────────────────────────► Save to L2 & L1 │
│   │ (with __next) │                                           │
│   └───────────────┘                                           │
└───────────────────────────────────────────────────────────────┘
```

### Cache Tiers & TTLs
* **L1 In-Memory Cache**:
  * Scoped to the active server process.
  * Default TTL: **1 hour** (`memoryTtlMs: 3_600_000`).
  * Indexing: Three lookup maps for $O(1)$ access:
    * `byOptionId`: Map by numeric ID (e.g. `"10283"`).
    * `byExternalCode`: Map by `picklistId:externalCode` (e.g. `"gender:M"`).
    * `byPicklistId`: Map of arrays for catalog listing.
* **L2 Disk Cache**:
  * Stored on the local filesystem under `~/.cache/ssff-mcp/`.
  * Default TTL: **24 hours** (`diskTtlMs: 86_400_000`).
  * Permissions: POSIX mode `0700` for directories, `0600` for JSON cache files.

### Lazy Loading Granularity (SAP ➔ Disk ➔ RAM)
To accommodate picklists with 15,000+ entries without ballooning RAM or stalling the process:
1. **Granular Disk Files**: Picklists are stored individually under a directory scoped to the tenant and alias:
   ```
   ~/.cache/ssff-mcp/picklists-<tenant>-<alias>/<picklistId>.json
   ```
2. **On-Demand Loading**:
   * If a query touches only `gender`, only `gender.json` is read from disk into RAM.
   * Large picklists like `postal_codes.json` remain untouched on disk until an entity referencing them is queried.
3. **Automatic OData Pagination**:
   * When fetching from SAP SuccessFactors, `PicklistService` evaluates `d.__next`.
   * For catalogs exceeding the OData page limit (typically 1,000 items), the fetch loop follows `$skiptoken` URLs until the catalog is complete.

---

## 4. Invalidation & Cache Management

### CLI Invalidation
The CLI command `ssff-mcp cache invalidate` deletes both `$metadata` and all picklist caches (both granular directories and monolithic files):

```bash
# Invalidate a single environment
ssff-mcp cache invalidate prod

# Invalidate all configured environments
ssff-mcp cache invalidate --all

# Target a specific tenant in multi-tenant configurations
ssff-mcp cache invalidate prod --tenant tenant-emea
```
* **Network Independence**: The CLI deletes files on disk without making network requests. The running MCP server automatically reloads picklists on its next read.

### On-Demand Invalidation via Tool
The `resolve_picklist` tool supports the parameter `forceRefresh: true`. When specified, it bypasses L1 and L2 caches, queries SuccessFactors immediately, and overwrites the local cache.

---

## 5. Metadata Auto-Discovery

When `ssff-mcp` parses the environment `$metadata` XML:
* Every property with a `sap:picklist` attribute has its `picklistId` extracted and recorded in the entity schema.
* This metadata is exposed to AI agents via the MCP resource `sf://{env}/entities/{entitySet}`:

```json
{
  "name": "gender",
  "type": "Edm.String",
  "nullable": true,
  "picklistId": "gender"
}
```
This enables LLMs to proactively recognize which fields are picklists and identify valid query values.

---

## 6. Localized Label Resolution Chain

When resolving a label for a specific locale (e.g. `es_ES` or `es`), `resolveLabel()` executes an automatic degradation fallback chain:

1. **Direct Match**: Exact locale (e.g., `es_ES` or language prefix `es`).
2. **English Default**: Falls back to `en_US`.
3. **System Default**: Falls back to `defaultValue`.
4. **Code Fallback**: Falls back to `externalCode`.
5. **Raw Fallback**: Falls back to the raw `optionId`.

Locale precedence:
1. Tool argument: `locale` passed in `query_entity` or `resolve_picklist`.
2. Config file: `defaultLocale` defined in `config.json`.
3. Environment variable: `SF_DEFAULT_LOCALE`.
4. Fallback default: `en_US`.

---

## 7. The `resolve_picklist` MCP Tool

A dedicated MCP tool is available for agents and users to inspect picklists directly:

### Use Cases:
* **Caso A: Search by label (Reverse Search)**
  Find the exact `optionId` or `externalCode` to construct an OData `$filter`:
  ```json
  {
    "environment": "prod",
    "query": "casado",
    "picklistId": "maritalStatus",
    "locale": "es_ES"
  }
  ```
  Returns matching options with a `suggestedFilter` (e.g. `maritalStatus eq '10119'`).

* **Caso B: Resolve specific Option ID or External Code**
  Translate an ID to human-readable text:
  ```json
  {
    "environment": "prod",
    "picklistId": "gender",
    "optionId": "10283",
    "locale": "es_ES"
  }
  ```
  Returns `optionId`, `externalCode`, `label`, and status.

* **Caso C: List all active options of a picklist**
  Explore available choices:
  ```json
  {
    "environment": "prod",
    "picklistId": "gender",
    "locale": "es_ES"
  }
  ```

---

## 8. Coexistence with OData `$expand`

Using `resolvePicklists: true` is **entirely additive and optional**:
* Operators who prefer traditional OData `$expand` (e.g. `$expand=genderNav/picklistLabels`) can continue using it without restriction.
* `$expand` navigations are validated against `entityAllowlist` as usual.
* Local resolution (`resolvePicklists: true`) provides a high-performance alternative that avoids SAP database joins, reduces network traffic, and works without configuring navigation allowlists.
