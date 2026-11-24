/**
 * @fileoverview Discriminated union of the credential bundles a backup target can hold.
 * @module src/backup/types/backup-target-secret.type
 *
 * ONE JSON bundle through ONE encrypted trio, discriminated by auth_method. SFTP password vs private
 * key + passphrase vs Graph client secret vs certificate all share a single call site into
 * encryptApiKey(), so adding a target type adds a union member rather than three more columns.
 *
 * This type is INTERNAL. It is never part of a response body — see BackupTargetsService.toResponse().
 */

export type BackupTargetSecret =
  | { auth_method: 'sftp_password'; password: string }
  | {
      auth_method: 'sftp_private_key';
      private_key: string;
      passphrase?: string;
    }
  | {
      auth_method: 'graph_client_secret';
      tenant_id: string;
      client_id: string;
      client_secret: string;
    }
  | {
      auth_method: 'graph_certificate';
      tenant_id: string;
      client_id: string;
      private_key: string;
      thumbprint: string;
    };

/** The four legal auth methods, as a value list for runtime validation. */
export const BACKUP_AUTH_METHODS = [
  'sftp_password',
  'sftp_private_key',
  'graph_client_secret',
  'graph_certificate',
] as const;

export type BackupAuthMethod = (typeof BACKUP_AUTH_METHODS)[number];

/** The two legal target types. */
export const BACKUP_TARGET_TYPES = ['sftp', 'sharepoint'] as const;

export type BackupTargetType = (typeof BACKUP_TARGET_TYPES)[number];

/**
 * Which auth methods are legal for which target type. Mirrors the
 * backup_targets_auth_matches_type_check CHECK constraint so the caller gets a readable 400 instead
 * of a 23514 surfaced as a 500.
 */
export const AUTH_METHODS_BY_TARGET_TYPE: Record<
  BackupTargetType,
  readonly BackupAuthMethod[]
> = {
  sftp: ['sftp_password', 'sftp_private_key'],
  sharepoint: ['graph_client_secret', 'graph_certificate'],
};
