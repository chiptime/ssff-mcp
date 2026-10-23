/**
 * Tenant-scoped role selection for IAS-authenticated users — Phase 3 slice S1
 * (FR-03–FR-06 of docs/PRD-phase3-ias-roles.md; see docs/phase3-role-resolution.md).
 *
 * PURE selection: resolve ONE effective role from an ALREADY VALIDATED
 * identity (tenant binding, issuer, subject and group claim were verified by
 * the authentication layer) or deny. This module does not authenticate, does
 * not read disk, does not compose entity/field policies (the layered-policy
 * seam owns that) and defines an INTERNAL domain API, NOT the final on-disk
 * configuration schema (PRD pending items P3–P5).
 *
 * Selection rules (PRD §4, "Resolución del rol"):
 * - A manual assignment to a DECLARED role wins; groups are not consulted.
 * - A manual assignment to an UNDECLARED role denies with NO group fallback
 *   (FR-05): a dangling reference never authorizes through groups.
 * - Without a manual assignment, mapped groups must collapse to exactly ONE
 *   distinct role: zero roles denies, several distinct roles deny as
 *   ambiguous, and several groups mapped to the same role yield that single
 *   role (FR-03).
 * - The technical role is an ordinary declared role (FR-06): nothing here
 *   special-cases it, and no identity receives a role without an assignment
 *   or a group mapping.
 * - The identity must match the configuration's tenant and issuer EXACTLY;
 *   any mismatch denies before any lookup (no cross-tenant resolution).
 * - A configuration that fails validation fails closed: resolution returns
 *   `malformed_config`, never a guessed role.
 *
 * All lookups run over Map/Set state normalized from the configuration, so
 * inherited/prototype properties ("constructor", "__proto__", "toString")
 * can never act as role, group or subject keys.
 */

/** One role declared for a single tenant. */
export interface DeclaredRole {
  /**
   * Role name, unique within the declaring tenant. Roles are tenant-local:
   * two tenants may declare the same name with unrelated permissions.
   * Environment scope and entity/field policy attach at the layered-policy
   * seam (S2); selection only needs the name.
   */
  name: string;
}

/** Manual assignment of one user (stable subject) to one role. */
export interface ManualAssignment {
  /**
   * Stable token subject of the assigned user. The full stable identifier is
   * (issuer, subject) resolved against this tenant configuration; display
   * names and emails MUST NOT be used.
   */
  subject: string;
  /**
   * Assigned role name. May reference a role that is no longer declared:
   * resolution then denies that user with no group fallback (FR-05).
   */
  role: string;
}

/**
 * The role configuration of ONE tenant. INTERNAL domain shape, NOT the final
 * JSON schema: key names, file layout and identity representation remain
 * pending (PRD P4/P5).
 */
export interface TenantRoleConfig {
  /** Tenant this configuration belongs to. Identities must match exactly. */
  tenantId: string;
  /**
   * IAS issuer trusted for this tenant. Identities must match exactly;
   * issuer normalization (trailing slashes, case) is a pending integration
   * decision (P3) that the caller owns.
   */
  issuer: string;
  /** Roles declared for this tenant. */
  roles: DeclaredRole[];
  /** IAS group name → declared role name. Every target MUST be declared. */
  groupMappings: Record<string, string>;
  /** Manual assignments; subjects must be unique within the tenant. */
  manualAssignments: ManualAssignment[];
}

/**
 * An identity already validated by the authentication layer: stable issuer
 * and subject, the tenant it is bound to, and the group claim exactly as
 * validated. Selection trusts these fields; it never re-authenticates. The
 * IAS group claim format is still pending (P3) and is not assumed here.
 */
export interface IasIdentity {
  tenantId: string;
  issuer: string;
  subject: string;
  /** Group names as validated in the token; compared exactly, never normalized. */
  groups: readonly string[];
}

/** Machine-readable reason a role resolution denied. Never invents a role. */
export type RoleDenialReason =
  /** Identity tenant or issuer does not match the configuration's binding. */
  | "identity_mismatch"
  /** Configuration failed validation; no role is ever guessed. */
  | "malformed_config"
  /** Manual assignment references an undeclared role; groups are not consulted. */
  | "invalid_manual_role"
  /** No manual assignment and no group-derived role. */
  | "no_role"
  /** Groups collapse to several distinct roles. */
  | "ambiguous_roles";

/** The single outcome of role selection for one request. */
export type RoleResolution =
  | { outcome: "resolved"; role: string }
  | { outcome: "denied"; reason: RoleDenialReason };

/** Structured validation error for a tenant role configuration. */
export interface TenantRoleConfigError {
  /** Operator-facing description of the first defect found. */
  message: string;
}

/** Normalized, lookup-ready projection of a valid configuration. */
interface NormalizedRoleConfig {
  roleNames: Set<string>;
  groupToRole: Map<string, string>;
  manualBySubject: Map<string, string>;
}

/**
 * Non-empty by the repo's convention: trimmed for the emptiness check, kept
 * as-is for matching (same rule as alias/tenant ids in src/config.ts).
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate and normalize one tenant's configuration. Returns the first defect
 * found (deterministic for an identical object) or the lookup-ready
 * projection. Fails closed on: missing or wrong-shaped parts, empty
 * identifiers, duplicate role names, duplicate manual subjects, and group
 * mappings that reference undeclared roles. Dangling MANUAL role references
 * are NOT defects here: FR-05/D12 turns them into a per-request denial so
 * the rest of the tenant keeps operating while the assignment is cleaned up.
 */
function normalizeTenantRoleConfig(
  config: TenantRoleConfig,
): NormalizedRoleConfig | TenantRoleConfigError {
  if (!isNonEmptyString(config.tenantId)) {
    return { message: "tenantId must be a non-empty string" };
  }
  if (!isNonEmptyString(config.issuer)) {
    return { message: "issuer must be a non-empty string" };
  }
  if (!Array.isArray(config.roles)) {
    return { message: "roles must be an array of declared roles" };
  }
  if (typeof config.groupMappings !== "object" || config.groupMappings === null) {
    return { message: "groupMappings must be an object of group name to role name" };
  }
  if (!Array.isArray(config.manualAssignments)) {
    return { message: "manualAssignments must be an array of manual assignments" };
  }

  const roleNames = new Set<string>();
  for (const role of config.roles) {
    const name = role?.name;
    if (!isNonEmptyString(name)) {
      return { message: "declared role name must be a non-empty string" };
    }
    if (roleNames.has(name)) {
      return { message: `duplicate declared role name: ${name}` };
    }
    roleNames.add(name);
  }

  // Object.entries yields ONLY own enumerable string keys, so inherited
  // properties can never smuggle a mapping in; the Map keeps lookups exact.
  const groupToRole = new Map<string, string>();
  for (const [group, role] of Object.entries(config.groupMappings)) {
    if (!isNonEmptyString(group)) {
      return { message: "group mapping key must be a non-empty group name" };
    }
    if (typeof role !== "string" || !roleNames.has(role)) {
      return {
        message: `group mapping for "${group}" references undeclared role: ${String(role)}`,
      };
    }
    groupToRole.set(group, role);
  }

  const manualBySubject = new Map<string, string>();
  for (const assignment of config.manualAssignments) {
    const subject = assignment?.subject;
    if (!isNonEmptyString(subject)) {
      return { message: "manual assignment subject must be a non-empty string" };
    }
    if (manualBySubject.has(subject)) {
      return { message: `duplicate manual assignment for subject: ${subject}` };
    }
    manualBySubject.set(subject, assignment.role);
  }

  return { roleNames, groupToRole, manualBySubject };
}

/**
 * Load-time validation: `undefined` means the configuration may be used; an
 * error means the tenant configuration must be REJECTED, fail closed.
 */
export function validateTenantRoleConfig(
  config: TenantRoleConfig,
): TenantRoleConfigError | undefined {
  const normalized = normalizeTenantRoleConfig(config);
  return "message" in normalized ? normalized : undefined;
}

/**
 * Resolve the single effective role for one already-validated identity.
 *
 * Evaluation order:
 * 1. Trust boundary: identity tenant AND issuer must equal the
 *    configuration's binding, exactly. A mismatch denies before any lookup.
 * 2. Fail closed on a configuration that does not validate.
 * 3. Manual assignment: declared role → resolved; undeclared role → denied
 *    with `invalid_manual_role` and NO consultation of groups (FR-05).
 * 4. Group mapping: mapped roles collapse to a set; exactly one distinct
 *    role resolves, zero deny with `no_role`, several distinct deny with
 *    `ambiguous_roles` (FR-03).
 */
export function resolveEffectiveRole(
  config: TenantRoleConfig,
  identity: IasIdentity,
): RoleResolution {
  if (identity.tenantId !== config.tenantId || identity.issuer !== config.issuer) {
    return { outcome: "denied", reason: "identity_mismatch" };
  }

  const normalized = normalizeTenantRoleConfig(config);
  if ("message" in normalized) {
    return { outcome: "denied", reason: "malformed_config" };
  }

  const manualRole = normalized.manualBySubject.get(identity.subject);
  if (manualRole !== undefined) {
    return normalized.roleNames.has(manualRole)
      ? { outcome: "resolved", role: manualRole }
      : { outcome: "denied", reason: "invalid_manual_role" };
  }

  const distinctRoles = new Set<string>();
  for (const group of identity.groups) {
    const role = normalized.groupToRole.get(group);
    if (role !== undefined) {
      distinctRoles.add(role);
    }
  }
  const [soleRole] = distinctRoles;
  if (distinctRoles.size === 1 && soleRole !== undefined) {
    return { outcome: "resolved", role: soleRole };
  }
  return distinctRoles.size === 0
    ? { outcome: "denied", reason: "no_role" }
    : { outcome: "denied", reason: "ambiguous_roles" };
}
