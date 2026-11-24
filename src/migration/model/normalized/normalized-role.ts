/**
 * @fileoverview Source-agnostic project role + its actors. Maps in Phase 3 to space
 * roles / custom roles. Group actors carry no email — membership expansion is best-effort.
 */

export interface NormalizedRoleActor {
  type: 'user' | 'group';
  /** User stable id (username/accountId) or group name. */
  sourceId: string;
  name: string;
}

export interface NormalizedRole {
  /** Stable role id (numeric as string). */
  sourceId: string;
  name: string;
  description?: string;
  actors: NormalizedRoleActor[];
}
