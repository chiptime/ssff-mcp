# Layered policy evaluation (Phase 3, internal)

`src/layered-policy.ts` composes the existing environment policy with a role
policy into one explicit decision for a single entity, protocol, and schema-key
set. It implements the permission-composition rules of the Phase 3 PRD
(FR-07, FR-08) without inventing a new policy language: every list keeps the
current `entityAllowlist` / `entityDenylist` / `fields` semantics, reused
through the existing helpers `isEntityPermitted` and `permittedFieldsFor`.

**Internal status:** this module is Phase 3 scaffolding. It defines no
configuration schema, validates no tokens, and is not wired into any tool,
HTTP, or redaction surface yet (see [Not delivered](#not-delivered)).

## Quick path

1. Build a query: the entity set name, optional protocol (default `v2`), the
   entity's schema keys (`undefined` when the schema could not be resolved),
   and the two policy layers.
2. Call `evaluateLayeredPolicy(query)` and consume the explicit decision:
   `permitted`, `reason` (set on every denial path), and `fields`.
3. Treat `fields.kind === "restricted"` as the exhaustive readable set (schema
   keys already included); `"unrestricted"` means no narrowing at all.

```text
environment policy ─┐
                    ├─ evaluateLayeredPolicy ── { permitted, reason, fields }
role policy ────────┘
```

## Semantics

| Rule | Behavior |
|---|---|
| Entity needs both layers | The entity is permitted only when the environment AND role layers both permit it; neither layer can widen the other (FR-08). |
| Denylist wins | A denylist entry in either layer denies the entity, whatever any allowlist says. When both layers deny, the environment reason is reported first: it is the ceiling. |
| Absent/empty narrows nothing, per layer | An absent or empty `entityAllowlist` — or absent/empty `fields` — does not restrict that layer, and never removes the other layer's restriction (FR-07: no implicit deny-all). |
| Field intersection | When both layers restrict fields, the readable set is their intersection plus the schema keys. A single restricting layer applies as-is (plus keys). |
| Restricted empty is never unrestricted | Field outcomes are a discriminated union (`unrestricted` vs `restricted` with a `Set`). Disjoint restrictions stay `restricted` with only the keys readable — possibly an empty set. Derived lists are never passed back into the legacy helpers, where `[]` would read as "no narrowing". |
| Keys are always readable — for permitted entities | Schema keys are added to every restricted set, mirroring `allowedProperties`. On a denied entity nothing is readable: keys never rescue a denied entity. |
| Unresolved schema fails closed | If any restriction applies but `schemaKeys` is `undefined`, the decision denies with reason `{ source: "schema", cause: "unresolved" }` — an absent schema is never silently read as "no keys" (the `allowedProperties` principle). `schemaKeys: []` (resolved, zero keys) is honored as-is. |
| Protocol semantics unchanged | Protocol filtering and the `v2` default come from the reused helpers; `protocols`-bearing entries keep their exact current meaning. |
| Input validation | Invalid internal inputs (empty entity, unknown protocol, non-array lists, missing layer) throw `TypeError` before evaluation; every denial path in the decision is explicit. |

## Decision reference

```ts
interface PolicyLayer {
  entityAllowlist?: AllowlistEntry[]; // existing semantics, reused as-is
  entityDenylist?: AllowlistEntry[];
}

type FieldAccess =
  | { kind: "unrestricted" }
  | { kind: "restricted"; fields: ReadonlySet<string> }; // keys included

type LayeredDenialReason =
  | { source: "environment" | "role"; cause: "denylist" | "allowlist" }
  | { source: "schema"; cause: "unresolved" };

interface LayeredDecision {
  entity: string;
  protocol: AllowlistProtocol;
  permitted: boolean;
  reason: LayeredDenialReason | undefined; // set on every denial
  fields: FieldAccess; // restricted ∅ on any denied entity
}

function evaluateLayeredPolicy(query: {
  entity: string;
  protocol?: AllowlistProtocol; // default "v2"
  schemaKeys: string[] | undefined; // undefined = schema unresolved
  environment: PolicyLayer;
  role: PolicyLayer;
}): LayeredDecision;
```

Layer input validation is shallow on purpose: entry-level validation (entity
names, protocol lists, duplicates) already belongs to the config layer that
produces `AllowlistEntry[]`; this module only rejects structurally invalid
queries so no layer can be silently skipped.

## Not delivered

FR-09 remains open; this module makes no integration claim:

- The evaluator is **not wired** into `query_entity`, `batch_get`,
  navigation/expand checks, `inspect_entity`, schema filtering, redaction, or
  the XML downgrade path. Those surfaces still consume a single legacy policy.
- No final configuration schema is introduced (the PRD's model is a conceptual
  contract); nothing here parses tenant files or role definitions.
- The role layer's producer (role resolution from manual assignments and IAS
  groups) is a separate Phase 3 unit; this module only consumes two already
  built policies.
- No hosted authentication, token validation, tenant binding, per-request
  freshness, or session/cursor isolation: those belong to later integration
  tasks gated on the configured OIDC application.

## Verification

Focused command (project runner):

```sh
pnpm build && node --test dist/test/layered-policy.test.js
```

Observed on 2026-10-22: 16 tests pass, 0 fail, covering both-layers-required,
either-denylist-wins, per-layer absent/empty semantics, intersection and
restricted-empty field outcomes, key readability, denied-entity keys, protocol
matching, the fail-closed schema rule, input validation, and reuse pins of
`isEntityPermitted` / `permittedFieldsFor`.
