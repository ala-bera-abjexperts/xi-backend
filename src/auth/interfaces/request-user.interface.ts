/**
 * @fileoverview Interface for the authenticated user object attached to every request
 * by the {@link SupabaseAuthGuard}. Provides both the Supabase auth ID and the
 * application-level public user ID, plus the user's currently active organization
 * and the full list of organizations they belong to.
 * @module src/auth/interfaces/request-user.interface
 * @author Prince Jadiya
 */

/**
 * One row in {@link RequestUser.memberships}. The Atlassian-style switcher
 * needs the org slug at render time, so we denormalise it here to spare every
 * controller from fetching the orgs table again.
 */
export interface RequestUserMembership {
  /** Organization UUID (`organization_members.organization_id`). */
  organizationId: string;

  /** URL slug from `organizations.slug` — pre-joined for the tenant switcher UI. */
  organizationSlug: string;

  /** Role of the caller in this org. Constrained to the DB CHECK constraint values. */
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

/** Set by SupabaseAuthGuard Phase B when a valid impersonation_token cookie is present AND the request's resolved tenant agrees with the session's target tenant. When set, the surrounding RequestUser.userId/email/organizationId/role are the TARGET user's values; the SA's real identity is preserved here for audit and banner rendering. */
export interface ImpersonationContext {
  sessionId: string;
  realUserId: string; // public.users.id of the SA
  realAuthUserId: string; // auth.users.id of the SA (forensic)
  realEmail: string;
  realOrganizationId: string; // SA's home org (super-tenant)
  targetUserId: string;
  targetOrganizationId: string;
  targetMembershipRole: 'owner' | 'admin' | 'member' | 'viewer';
  writeAccess: boolean;
  expiresAt: string; // ISO8601
  startedAt: string;
  reason: string;
}

/**
 * Authenticated user context attached to `request.user` by the Supabase auth guard.
 *
 * The distinction between `authUserId` and `userId` is critical:
 * - `authUserId` maps to `auth.users.id` (Supabase internal)
 * - `userId` maps to `public.users.id` (application-level, used in foreign keys)
 */
export interface RequestUser {
  /** Supabase auth user ID from `auth.users.id`, extracted from the JWT `sub` claim */
  authUserId: string; // auth.users.id (from JWT sub)

  /** Application-level user ID from `public.users.id`, resolved via the users service */
  userId: string; // public.users.id

  /** User's email address from the public users table or JWT */
  email: string;

  /**
   * The user's currently ACTIVE organization for this request.
   *
   * Resolution order (implemented in {@link SupabaseAuthGuard}):
   *   1. `active_org_id` cookie (signature verified + membership re-checked)
   *   2. First membership row by `organization_members.created_at` ASC
   *      (so a fresh user gets their oldest/first org)
   *   3. Empty string `''` — onboarding state, the user has no memberships yet.
   *      Org-scoped services must continue to guard against this before
   *      querying tenant-scoped tables.
   *
   * Every existing call site that reads `user.organizationId` keeps working
   * unchanged because the field still resolves to a single string.
   */
  organizationId: string;

  /**
   * Every organization this user is a member of, ordered oldest-first.
   *
   * Populated on every authenticated request from a single
   * `organization_members JOIN organizations` query, so controllers that need
   * to validate "could this user access org X" can do so without an extra DB
   * round-trip. Empty array means the user is in onboarding state.
   */
  memberships: RequestUserMembership[];

  /** Application-level role label from `public.users.role` */
  role?: string | null;

  /** Whether the public user row is active */
  isActive?: boolean | null;

  /** Server-controlled Supabase Auth app metadata from the verified token/auth user */
  appMetadata?: Record<string, unknown>;

  /** Set by SupabaseAuthGuard Phase B when a valid impersonation overlay is active. */
  impersonation?: ImpersonationContext;
}
