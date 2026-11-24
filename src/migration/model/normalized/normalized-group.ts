/**
 * @fileoverview Source-agnostic user group. Maps to org-scoped `user_groups` + `user_group_members`.
 *
 * Jira groups are instance-wide and `user_groups` has no `space_id`, so like resolutions this is a
 * genuinely org-level entity on both sides.
 *
 * `sourceId` is the group NAME on Jira Server, which has no group id. On Cloud the stable handle is
 * `groupId` — a Cloud implementation must key the crosswalk on that instead, or renames will fork
 * identities. Recorded here so the P8 author does not key on name out of symmetry.
 */

export interface NormalizedGroup {
  /** Server: group name. Cloud: groupId. */
  sourceId: string;
  name: string;
}
