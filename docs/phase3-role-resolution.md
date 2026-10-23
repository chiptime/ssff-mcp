# Phase 3 role resolution (slice S1)

> Internal, tenant-scoped role selection for IAS-authenticated users. `src/role-policy.ts`
> resolves exactly ONE effective role from an already-validated identity, or denies. This
> is the local S1 slice of `odd/tasks/phase3-ias-roles.md` (FR-03–FR-06 of
> `docs/PRD-phase3-ias-roles.md`); completing it does not complete the PRD.

## Quick path

1. **Load time:** `validateTenantRoleConfig(config)` — any error rejects the whole tenant
   configuration (fail closed); `undefined` means it may be used.
2. **Per request:** `resolveEffectiveRole(config, identity)` with the ALREADY validated
   identity (tenant binding, issuer, subject and group claim).
3. **Consume:** `{ outcome: "resolved", role }` authorizes under that role;
   `{ outcome: "denied", reason }` rejects the request with no business query to SSFF.
   A denial never carries or invents a role.

## Decision table

| Situation (identity already validated) | Result | Reason |
|---|---|---|
| Manual assignment → declared role | That role; groups never consulted | — |
| Manual assignment → undeclared role | Deny, NO group fallback | `invalid_manual_role` |
| No manual; mapped groups collapse to one distinct role | That role | — |
| No manual; several groups map to the SAME role | The single role (deduplicated, never a union) | — |
| No manual; mapped groups yield several distinct roles | Deny | `ambiguous_roles` |
| No manual; no group maps to a role | Deny | `no_role` |
| Identity tenant or issuer differs from the configuration's binding | Deny before any lookup | `identity_mismatch` |
| Configuration fails validation | Deny, never a guessed role | `malformed_config` |

The technical role is an ordinary declared role (FR-06): nothing special-cases it, and no
identity receives any role without a manual assignment or a group mapping.

## Internal API (NOT the final config schema)

| Type | Role |
|---|---|
| `IasIdentity` | `{ tenantId, issuer, subject, groups }` — stable issuer + subject bound to a tenant; never a display name or email |
| `TenantRoleConfig` | One tenant's binding (`tenantId`, `issuer`), declared `roles`, `groupMappings` and `manualAssignments` |
| `DeclaredRole` | Tenant-local role name; environment scope and entity/field policy attach at the S2 layered-policy seam |
| `ManualAssignment` | `{ subject, role }`; the stable key is (config.issuer, subject) |
| `RoleResolution` | `{ outcome: "resolved", role }` or `{ outcome: "denied", reason }` |
| `validateTenantRoleConfig` | Load-time, fail-closed configuration check |
| `resolveEffectiveRole` | Pure per-request selection |

Key names, file layout and the serialized identity representation are pending PRD
technical decisions (P3–P5). This module is the internal seam those decisions plug into;
it must not be exposed as a public schema.

## Security invariants

- **Exact matching, no normalization.** Tenant, issuer, subject, group and role names
  compare byte-for-byte. Issuer normalization is a pending integration decision (P3); the
  selector refuses to guess (a trailing-slash difference denies with `identity_mismatch`).
- **Trust boundary first.** A foreign tenant or issuer denies before any lookup, so no
  cross-tenant assignment or group can ever match, even for a stolen subject.
- **Fail closed.** Missing or wrong-shaped parts, empty identifiers, duplicate role names,
  duplicate manual subjects, or a group mapping to an undeclared role make the
  configuration invalid; resolution then denies (`malformed_config`) and never falls back
  to an arbitrary role.
- **Dangling manual references are per-request denials, not load errors** (FR-05/D12): a
  role deleted while its assignment remains denies that user with no group fallback, and
  the rest of the tenant keeps operating until the assignment is cleaned up.
- **Prototype-safe lookups.** All lookups run over `Map`/`Set` built from own enumerable
  keys, so `constructor`, `__proto__` or `toString` can never act as a group, subject or
  role.
- **Groups come from the validated claim.** The IAS group-claim format is pending (P3);
  this module only receives already-validated strings and invents no structure.

## Out of scope (by design)

Authentication and token validation, hosted HTTP surfaces, session and cursor isolation,
per-request freshness, audit logging (S4), OpenCode acceptance (S5), entity/field policy
composition and environment ceilings (S2, `src/layered-policy.ts`), and the final JSON
configuration schema (P4/P5). API-key and STDIO behavior are untouched: this module is
additive and imported by nobody yet.

## Verification

```bash
pnpm build && node --test dist/test/role-policy.test.js
```

One test per named rule covers FR-03 (single, zero, ambiguous and same-role groups;
determinism), FR-04 (manual precedence and re-evaluation after removal), FR-05 (dangling
manual denies without fallback), FR-06 (ordinary technical role, no automatic access),
the tenant/issuer trust boundary, fail-closed validation and prototype safety.
