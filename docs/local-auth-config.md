# Local users and personal tokens (interim Phase 1)

Fixed local MCP users with personal random tokens now authenticate against the hosted config, while SSFF keeps using its single configured technical account per environment. This closes the gap between "one technical account" and "individual people calling the MCP server" without waiting for IAS (Phase 2). Source of truth: `odd/tasks/local-user-tokens.md` S1–S3, S6.

## Quick path

1. Generate a high-entropy token (the token CLI prints it once; only its hash is stored).
2. Add `roles` and `users` under your tenant in `~/.config/ssff-mcp/config.json` (see shape below).
3. Run `loadHostedAuthDirectory`-backed serving (`ssff-mcp serve` integration lands with the HTTP work) — present the token per request; expiry, revocation and role changes apply on the NEXT request, open session included.

## Configuration shape

```json
{
  "tenants": {
    "acme": {
      "apiKeyHash": "<sha-256 of the legacy client key, optional>",
      "environments": {
        "prod": { "baseUrl": "https://api.example.com", "auth": { "type": "basic", "username": "tech", "password": { "fromEnv": "SSFF_PASSWORD" } } }
      },
      "roles": {
        "reader": { "environments": ["prod"], "entityDenylist": [{ "entity": "PerPersonal" }] }
      },
      "users": {
        "alice": {
          "role": "reader",
          "enabled": true,
          "tokens": [
            { "id": "laptop", "hash": "<lowercase sha-256 hex>", "expiresAt": "2027-01-01T00:00:00Z", "revoked": false }
          ]
        }
      }
    }
  }
}
```

## Rules

| Topic | Decision |
|-------|----------|
| `roles` / `users` keys | Optional per tenant; both absent keeps the previous behavior exactly. Roles may exist with no users (no principal ⇒ no access). |
| Role `environments` | Mandatory, non-empty, duplicate-free; every alias must be one the tenant declares. No default role: a user's role must exist in the same tenant. |
| User record | Stable non-empty id, exactly one `role`, `enabled` (default `true`), `tokens` (required; `[]` revokes everything at once). No SSFF credentials, no issuer/subject or other IAS-like fields — records are strict. |
| Token record | `id` unique within its user; `hash` is the lowercase sha-256 hex of the token; `expiresAt` is REQUIRED and must be an ISO 8601 date-time WITH timezone (`Z` or offset); `revoked` defaults to `false`. |
| Expiry | `now >= expiresAt` never authenticates. An expired date is still VALID config — it needs no cleanup to be inert. |
| Rotation | Add a new token record, then set `revoked: true` on the old one. Sessions bind to (authType, tenant, user), never to the token, so a valid rotation does not grant a different identity's session. |
| Collisions | ANY duplicate credential hash — the same token hash twice (within one user, across users, or across tenants) or a token hash equal to a legacy API-key hash — fails the whole load with `CONFIG_INVALID`, even when records are expired/revoked/disabled. A rejected named token must never fall back to, or gain, legacy access. |
| Legacy keys | `apiKeyHash` semantics are unchanged (tenant-wide and per-environment keys, innermost wins, cross-tenant ambiguity ⇒ reject). |
| STDIO | `loadConfig` accepts files with `roles`/`users` but ignores local auth entirely — STDIO keeps its current behavior. |
| Secrets | The hosted loaders validate shape only: no SSFF secret is resolved, nothing is fetched over the network, and user records never copy the technical account's credentials. |

## Where the code lives

| Export | File | Purpose |
|--------|------|---------|
| `LocalRole`, `LocalUser`, `LocalToken`, `LocalTenantAuth`, `HostedAuthDirectory`, `HostedAuthResolution` | `src/local-auth.ts` | Types for the local-auth slice and the discriminated resolution. |
| `resolveHostedAuth(directory, token, now?)` | `src/local-auth.ts` | One presented credential → `legacy_key` or `named_user` resolution, or `null` (fail-closed, no fallback). |
| `hasCredentialCollision(directory)` | `src/local-auth.ts` | The loader's fail-closed collision gate (named-vs-named and named-vs-legacy). |
| `loadHostedAuthDirectory(options)` | `src/config.ts` | Reads and validates one raw JSON snapshot (legacy keys + local auth); returns `{ legacyKeys, tenants, rawConfig }`. |

Token hashes are sha-256 because the tokens are system-generated random values (≥ 32 bytes), never user-chosen passwords — sha-256 is not acceptable password storage.

## What is deliberately NOT here

- No password login, admin UI, remote deployment, or identity provider (S2).
- No IAS integration and no issuer/subject fields on local records (S6): Phase 2 adds IAS without turning local tokens into IAS tokens.
- No policy enforcement in this slice: role `entityAllowlist`/`entityDenylist` only travel with the resolution (`role` field); the layered policy adapter applies them (S4, separate work).

## Verifying a setup

```text
test/local-auth.test.ts        resolver rules: scopes, expiry, revocation, collisions, no-fallback
test/config-local-auth.test.ts loader validation, defaults, collision gate, STDIO acceptance, legacy pins
```

Focus them with `node --test dist/test/local-auth.test.js dist/test/config-local-auth.test.js` after a build.
