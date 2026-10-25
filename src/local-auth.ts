/**
 * Local MCP users with personal tokens — interim Phase 1 (S1–S3, S6 of
 * odd/tasks/local-user-tokens.md).
 *
 * Fixed tenant-local users authenticate against the hosted config while SSFF
 * keeps using its ONE configured technical account per environment: user
 * records carry NO SSFF credentials of their own. Identity stays local and
 * independent of IAS (S6): there are deliberately no issuer/subject fields.
 *
 * This module is pure logic, no I/O: `loadHostedAuthDirectory` (src/config.ts)
 * reads and validates the JSON snapshot; `resolveHostedAuth` turns a presented
 * token into a resolution or `null`, fail-closed.
 *
 * Collision policy (fail-closed everywhere): every token hash in the hosted
 * space is unique — across users, across tenants, within one user, and against
 * legacy API-key digests — so a rejected (expired/revoked/disabled) named
 * token can NEVER fall back to, or collide with, legacy access. Legacy-vs-
 * legacy ambiguity keeps the existing resolveTenant semantics.
 */

import { timingSafeEqual } from "node:crypto";
import type { AllowlistEntry } from "./allowlist.js";
import { resolveTenant, sha256Hex, type TenantKeyDirectory } from "./tenancy.js";

/**
 * A tenant-local role (S1): an explicit, non-empty list of environment aliases
 * the role reaches, plus optional entity lists that only NARROW (applied as a
 * second layer by the policy adapter; absent lists narrow nothing here).
 */
export interface LocalRole {
  /** Environment aliases this role may reach; every alias must be declared by the tenant. */
  environments: string[];
  /** Optional entity narrowing for this role (absent = no narrowing). */
  entityAllowlist?: AllowlistEntry[];
  /** Entities always denied for this role; wins over `entityAllowlist`. */
  entityDenylist?: AllowlistEntry[];
}

/** One personal token record (S2/S3): hashes only, never cleartext tokens. */
export interface LocalToken {
  /** Stable id, unique within its user; lets rotation name the old record. */
  id: string;
  /** Lowercase sha-256 hex digest of the high-entropy random token (S2). */
  hash: string;
  /** ISO 8601 date-time WITH timezone; expiry inclusive: `now >= expiresAt` never authenticates. */
  expiresAt: string;
  /** Revocation flag (S3); effect on the next request, also with an open session. */
  revoked: boolean;
}

/** A fixed local MCP user (S1): stable id, exactly one declared role, personal tokens. */
export interface LocalUser {
  /** Name of a role declared in the same tenant; there is no default role. */
  role: string;
  /** Disabled users never authenticate (S3); defaults to true at load. */
  enabled: boolean;
  /** May be empty: the explicit way to revoke every token at once (S3). */
  tokens: LocalToken[];
}

/** The local-auth slice of ONE tenant. */
export interface LocalTenantAuth {
  /** Declared role records; may exist with no users (no principal => deny). */
  roles: Record<string, LocalRole>;
  /** Fixed users keyed by stable id. */
  users: Record<string, LocalUser>;
  /** Environment aliases the tenant declares (sorted); named scopes intersect this. */
  environments: string[];
}

/**
 * The whole hosted auth snapshot (one raw JSON config read): the legacy API-key
 * directory plus the local-auth projection of every tenant. `rawConfig` lets a
 * caller re-parse for a tenant slice WITHOUT re-reading the file; it contains
 * secrets-in-providers and must never be echoed.
 */
export interface HostedAuthDirectory {
  legacyKeys: TenantKeyDirectory;
  tenants: Record<string, LocalTenantAuth>;
  rawConfig: string;
}

/** Discriminated resolution of a presented credential. */
export type HostedAuthResolution =
  | {
      authType: "legacy_key";
      tenantId: string;
      /** Environment aliases this key may invoke; sorted (resolveTenant semantics). */
      allowedEnvironments: string[];
      /** sha-256 of the presented key; the ONLY credential digest a legacy session binds to. */
      credentialDigest: string;
    }
  | {
      authType: "named_user";
      tenantId: string;
      userId: string;
      roleName: string;
      /** Role envs, sorted, intersected with the tenant's declared environments. */
      allowedEnvironments: string[];
      /** The resolved role record (policy layers consume it). */
      role: LocalRole;
      credentialDigest: string;
      /** Id of the matched token record (sessions bind to the user, not the token). */
      tokenId: string;
    };

/**
 * Constant-time equality of two hex digests (length mismatch => false), the
 * same primitive resolveTenant uses for legacy keys.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/** True when any legacy tenant/environment key digest equals `digest`. */
function legacyKeyDigestExists(legacyKeys: TenantKeyDirectory, digest: string): boolean {
  for (const keys of Object.values(legacyKeys)) {
    if (keys === undefined) {
      continue;
    }
    if (keys.apiKeyHash !== undefined && constantTimeEquals(keys.apiKeyHash, digest)) {
      return true;
    }
    for (const declared of Object.values(keys.environments)) {
      if (declared !== undefined && constantTimeEquals(declared, digest)) {
        return true;
      }
    }
  }
  return false;
}

/** A token is live strictly BEFORE its expiry instant: `now >= expiresAt` is expired (fail closed). */
function isTokenLive(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) {
    return false;
  }
  return now < expiry;
}

/**
 * True when ANY credential hash in the hosted space is duplicated: a named
 * token hash appearing twice (within one user, across users or across
 * tenants), or colliding with a legacy tenant/per-environment key digest.
 *
 * Legacy-vs-legacy duplicates are deliberately NOT covered here — they keep
 * the existing resolveTenant ambiguity semantics (resolve => null). The hosted
 * loader rejects any directory where this returns true.
 */
export function hasCredentialCollision(directory: HostedAuthDirectory): boolean {
  const namedHashes = new Set<string>();
  for (const tenant of Object.values(directory.tenants)) {
    if (tenant === undefined) {
      continue;
    }
    for (const user of Object.values(tenant.users)) {
      if (user === undefined) {
        continue;
      }
      for (const token of user.tokens) {
        if (namedHashes.has(token.hash)) {
          return true;
        }
        namedHashes.add(token.hash);
      }
    }
  }
  for (const keys of Object.values(directory.legacyKeys)) {
    if (keys === undefined) {
      continue;
    }
    if (keys.apiKeyHash !== undefined && namedHashes.has(keys.apiKeyHash)) {
      return true;
    }
    for (const declared of Object.values(keys.environments)) {
      if (declared !== undefined && namedHashes.has(declared)) {
        return true;
      }
    }
  }
  return false;
}

/** The single (tenant, user, token record) a named digest matched. */
interface NamedMatch {
  tenantId: string;
  userId: string;
  user: LocalUser;
  token: LocalToken;
}

/**
 * Resolve one presented credential against the hosted directory (fail-closed).
 *
 * - Named tokens win the lookup: if exactly one token record matches the
 *   digest, the user must be enabled, the token unrevoked and unexpired —
 *   otherwise `null`, with NO fallback to legacy resolution.
 * - A digest matching more than one named record, or matching BOTH a named
 *   record and a legacy key, is ambiguous => `null` (the loader rejects such
 *   configs; this guard is defensive for hand-built directories).
 * - With no named match, legacy API keys keep the exact resolveTenant
 *   semantics (innermost wins; cross-tenant ambiguity => null).
 *
 * Sessions bind to (authType, tenant, user) — never the raw token — so token
 * rotation (S3) keeps a valid session while `credentialDigest` only pins
 * legacy sessions.
 */
export function resolveHostedAuth(
  directory: HostedAuthDirectory,
  token: string | undefined,
  now: number = Date.now(),
): HostedAuthResolution | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const digest = sha256Hex(token);

  // Sorted iteration: the same directory shape always resolves the same way.
  let match: NamedMatch | null = null;
  for (const tenantId of Object.keys(directory.tenants).sort()) {
    const tenant = directory.tenants[tenantId];
    if (tenant === undefined) {
      continue;
    }
    for (const userId of Object.keys(tenant.users).sort()) {
      const user = tenant.users[userId];
      if (user === undefined) {
        continue;
      }
      for (const tokenRecord of user.tokens) {
        if (!constantTimeEquals(tokenRecord.hash, digest)) {
          continue;
        }
        if (match !== null) {
          return null; // two records share this hash: ambiguous, fail closed
        }
        match = { tenantId, userId, user, token: tokenRecord };
      }
    }
  }

  if (match !== null) {
    // Defensive collision guard: a digest that is BOTH a named token and a
    // legacy key can never pick a side — and a rejected named token must not
    // gain legacy access — so fail closed before evaluating the record.
    if (legacyKeyDigestExists(directory.legacyKeys, digest)) {
      return null;
    }
    if (!match.user.enabled) {
      return null;
    }
    if (match.token.revoked) {
      return null;
    }
    if (!isTokenLive(match.token.expiresAt, now)) {
      return null;
    }

    const tenant = directory.tenants[match.tenantId]!;
    const role = tenant.roles[match.user.role];
    if (role === undefined) {
      return null; // no default role (S1): an unresolvable role denies
    }
    const declared = new Set(tenant.environments);
    const allowedEnvironments = [...new Set(role.environments)]
      .filter((alias) => declared.has(alias))
      .sort();
    return {
      authType: "named_user",
      tenantId: match.tenantId,
      userId: match.userId,
      roleName: match.user.role,
      allowedEnvironments,
      role,
      credentialDigest: digest,
      tokenId: match.token.id,
    };
  }

  // No named record claims this digest: legacy credentials resolve unchanged.
  const legacy = resolveTenant(directory.legacyKeys, token);
  if (legacy === null) {
    return null;
  }
  return {
    authType: "legacy_key",
    tenantId: legacy.tenantId,
    allowedEnvironments: legacy.allowedEnvironments,
    credentialDigest: digest,
  };
}
