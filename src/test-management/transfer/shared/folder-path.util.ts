import type { FolderNode } from './transfer-helpers';

/** The folder and every folder below it. */
export function folderSubtree(
  folders: FolderNode[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();

  for (const folder of folders) {
    if (!folder.parent_id) continue;

    const list = children.get(folder.parent_id) ?? [];

    list.push(folder.id);
    children.set(folder.parent_id, list);
  }

  const ids = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const id = queue.shift() as string;

    for (const child of children.get(id) ?? []) {
      if (ids.has(child)) continue;

      ids.add(child);
      queue.push(child);
    }
  }

  return ids;
}
