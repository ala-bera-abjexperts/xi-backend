/**
 * @fileoverview Source-agnostic user reference. Mapping (Phase 3) matches by EMAIL, else
 * creates a linked placeholder — never keyed on display names (localized), and NO invitation
 * emails are sent during migration. Cloud accountIds may have a null email (privacy settings).
 */

export interface NormalizedUser {
  sourceType: 'jira' | 'confluence';
  /** Stable id: Server username/key; Cloud accountId. */
  sourceId: string;
  /** Server login name when available (Cloud omits it). */
  username?: string;
  /** May be null/absent on Cloud (GDPR privacy) — placeholder path then applies. */
  email?: string;
  displayName: string;
  active: boolean;
  avatarUrl?: string;
}
