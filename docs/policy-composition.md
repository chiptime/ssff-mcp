# Policy composition: applying a role layer to every tool (S4, internal)

`src/policy-composition.ts` folds the ENVIRONMENT policy and the ROLE policy
into ONE value — a `CompositeEntityPolicy` — accepted everywhere a legacy
`entityAllowlist` array is accepted. Replacing the environment's
`entityAllowlist` value with the composite makes every surface (queries,
navigation, expand, batch, schemas, catalogs, resources, XML downgrade,
picklists) enforce both layers, with no other change in the pipeline. It
implements the S4 rule «ningún usuario puede ampliar el techo de permisos de la
cuenta técnica»: the role layer can only narrow, never widen.

**Internal status:** the adapter and helpers are ready; wiring the composite
into the environment config for named local users belongs to the integration
task (see [Not delivered](#not-delivered)). `evaluateLayeredPolicy`
([phase3-layered-policy.md](phase3-layered-policy.md)) remains the pure
one-query evaluator; this module is the reusable value the tool pipeline
consumes.

## Quick path

1. Build the composite from the environment's own lists and the effective
   role's lists — the environment layer is the ceiling, so it keeps the
   environment's `entityDenylist` too:

   ```ts
   import { intersectEntityPolicies } from "./policy-composition.js";

   const policy = intersectEntityPolicies(
     { entityAllowlist: env.entityAllowlist, entityDenylist: env.entityDenylist },
     { entityAllowlist: role.entityAllowlist, entityDenylist: role.entityDenylist },
   );
   ```

2. Use `policy` wherever `env.entityAllowlist` was used. Every helper in
   `allowlist.ts`, `allowlist-navigation.ts`, `fields.ts` and `metadata.ts`
   accepts it; keep passing `env.entityDenylist` beside it as before.

3. Never materialize the intersection as a plain array: `[]` means
   "unrestricted" in the legacy semantics. The composite exists precisely so
   an empty intersection stays a denial.

```text
environment lists ──┐
                    ├─ intersectEntityPolicies ── { kind: "composite", environment, role }
role lists ─────────┘                                   │
                                                        ▼
                        isEntityAllowed / isEntityPermitted / permittedFieldsFor
                        navigation · expand · batch · catalogs · redaction · XML
```

## Semantics

| Rule | Behavior |
|---|---|
| Both layers must permit | The composite dispatches to `isEntityPermitted` once per layer; a denylist in either layer wins within its layer. An entity missing from either layer's allowlist is denied. |
| A denylist beside the composite still wins | The `entityDenylist` passed next to the composite is enforced first; `intersectEntityPolicies` also folds it into the environment layer, and denying twice is idempotent. |
| Empty entity intersection denies all | When the layers share no entity, every entity is denied. The intersection is evaluated lazily per entity — no metadata enumeration, no materialized `[]`. |
| Fields: `undefined` only if both layers unrestricted | `permittedFieldsFor` intersects the two layers' field lists with the exact legacy per-layer semantics (`fields: []` narrows nothing in its own layer). |
| Restricted empty stays restricted | A disjoint field intersection is `[]`, which downstream reads as "schema keys only": `allowedProperties` builds `Set(configured + schema.keys)`, so `[]` becomes the key set — never "every property". An unresolved schema with any restriction throws `FieldNotPermittedError` (fail closed), mirroring `evaluateLayeredPolicy`'s `schema/unresolved` denial. |
| Legacy arrays unchanged | Every helper keeps its array path byte-for-byte; a value that is neither an array nor a `{ kind: "composite" }` object fails closed with a `TypeError`. |
| Validated producer | `intersectEntityPolicies` checks both layer shapes and returns a shallow-frozen composite holding the caller's layer objects by reference. |

## What the tests pin down

`test/policy-composition.test.ts` covers: entity decisions through both
layers; either-layer denylists; the denylist kept beside the composite;
protocol entries per layer; the no-common-entity denial; field intersections
including the restricted-empty case with schema keys; unresolved-schema fail
closed; record/schema redaction; navigation, expand and expression references
to denied targets; the Custom MDF catalog; equivalence with
`evaluateLayeredPolicy` across a matrix of layers, entities and protocols; and
the legacy array semantics.

## Not delivered

- Widening `EnvironmentConfig.entityAllowlist` to `EntityAllowlist` and
  resolving the current role per authenticated user (integration task).
- Any authentication, token, or configuration-schema change — out of scope by
  design; the adapter is pure.
