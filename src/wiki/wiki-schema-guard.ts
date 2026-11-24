import { ConflictException } from '@nestjs/common';

/** Counts `spreadsheet` nodes in a TipTap doc (JSON string or object); non-JSON → 0. */
export function countSpreadsheetNodes(content: unknown): number {
  let parsed: unknown = content;

  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return 0;
    }
  }

  let count = 0;
  const stack: unknown[] = [parsed];

  while (stack.length > 0) {
    const node = stack.pop();

    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;

    const record = node as Record<string, unknown>;

    if (record['type'] === 'spreadsheet') count++;
    if (Array.isArray(record['content'])) {
      for (const child of record['content'] as unknown[]) stack.push(child);
    }
  }

  return count;
}

/**
 * Rejects a save from a client that predates the spreadsheet node when it
 * would drop sheets from the stored page (an old editor deletes unknown nodes).
 */
export function assertSchemaCompatible(
  existingContent: unknown,
  incomingContent: unknown,
  headerValue: string | undefined,
): void {
  const version = Number(headerValue);

  if (Number.isFinite(version) && version >= 1) return;
  if (incomingContent === undefined || incomingContent === null) return;

  if (
    countSpreadsheetNodes(existingContent) >
    countSpreadsheetNodes(incomingContent)
  ) {
    throw new ConflictException({
      message:
        'This page was edited with a newer version of the app. Reload to continue.',
      code: 'WIKI_SCHEMA_OUTDATED',
    });
  }
}
