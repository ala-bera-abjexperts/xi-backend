/**
 * @fileoverview Interface representing the decoded payload of a Supabase JWT access token.
 * Used by the auth guard to extract user identity after token verification.
 * @module src/auth/interfaces/jwt-payload.interface
 * @author Prince Jadiya
 */

/**
 * Shape of the decoded Supabase JWT payload after verification.
 *
 * The `sub` field is the primary identifier linking to `auth.users.id` in Supabase.
 * Other fields are standard JWT claims or Supabase-specific extensions.
 */
export interface JwtPayload {
  /** The user's unique identifier from `auth.users.id` (JWT subject claim) */
  sub: string; // auth.users.id

  /** The user's email address, if available in the token */
  email?: string;

  /** Supabase role assigned to the user (e.g., `"authenticated"`) */
  role?: string; // Supabase role (e.g. 'authenticated')

  /** Supabase Auth app metadata, used only for server-controlled authorization claims */
  app_metadata?: Record<string, unknown>;

  /** Authentication Assurance Level (e.g., `"aal1"`, `"aal2"` for MFA) */
  aal?: string; // Authentication Assurance Level

  /** Authentication method references from Supabase Auth. */
  amr?: Array<string | { method?: string; timestamp?: number }>;

  /** Unique identifier for the current Supabase auth session */
  session_id?: string;

  /** Token issued-at timestamp (seconds since epoch) */
  iat?: number;

  /** Token expiration timestamp (seconds since epoch) */
  exp?: number;
}
