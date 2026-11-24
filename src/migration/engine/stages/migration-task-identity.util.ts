import { createHash } from 'node:crypto';

/** Version 1 namespace is immutable; changing this would create duplicate targets on replay. */
export function migrationTaskIdentity(
  orgId: string,
  connectionId: string,
  sourceId: string,
) {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'xisuite:migration:issue:v1',
        orgId,
        connectionId,
        sourceId,
      ]),
    )
    .digest('hex');
  const targetId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { version: 1, targetId } as const;
}
