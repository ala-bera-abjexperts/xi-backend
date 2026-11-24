/**
 * @fileoverview Conservative repair inventory for orphaned File Explorer
 * storage. It only considers keys emitted by FileExplorerStorageService's
 * canonical buildKey format and never removes a prefix owned by a live space.
 * @module src/file-explorer/file-explorer-storage-repair.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FileExplorerStorageService } from './file-explorer-storage.service';

const LOOKUP_BATCH_SIZE = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FileExplorerStorageRepairCandidate = {
  organizationId: string;
  spaceId: string;
  prefix: string;
  objectCount: number;
  paths: string[];
};

export type FileExplorerStorageRepairInventory = {
  scannedObjects: number;
  ignoredObjects: number;
  candidates: FileExplorerStorageRepairCandidate[];
};

export type FileExplorerStorageRepairResult = {
  applied: boolean;
  inventory: FileExplorerStorageRepairInventory;
  removedObjects: number;
  removedPrefixes: string[];
};

export class FileExplorerStorageRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = FileExplorerStorageRepairError.name;
  }
}

@Injectable()
export class FileExplorerStorageRepairService {
  private readonly logger = new Logger(FileExplorerStorageRepairService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly storage: FileExplorerStorageService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Produce a deterministic, non-mutating inventory of orphaned canonical keys.
   * A canonical key has the exact shape produced by buildKey:
   * org/file-explorer/space/node/version/filename.
   */
  async inventory(): Promise<FileExplorerStorageRepairInventory> {
    const allPaths = await this.storage.listPrefixStrict('');
    const grouped = new Map<string, FileExplorerStorageRepairCandidate>();
    let ignoredObjects = 0;

    for (const path of allPaths) {
      const parsed = this.parseCanonicalPath(path);
      if (!parsed) {
        ignoredObjects++;
        continue;
      }

      const key = `${parsed.organizationId}:${parsed.spaceId}`;
      const candidate = grouped.get(key) ?? {
        ...parsed,
        paths: [],
        objectCount: 0,
      };
      candidate.paths.push(path);
      candidate.objectCount++;
      grouped.set(key, candidate);
    }

    const groups = [...grouped.values()];
    const existingOrganizations = await this.findExistingOrganizations(
      groups.map((candidate) => candidate.organizationId),
    );
    const existingSpaces = await this.findExistingSpaces(
      groups.map((candidate) => candidate.spaceId),
    );

    const candidates = groups
      .filter((candidate) => {
        if (!existingOrganizations.has(candidate.organizationId)) return false;

        return !existingSpaces.has(
          `${candidate.organizationId}:${candidate.spaceId}`,
        );
      })
      .map((candidate) => ({
        ...candidate,
        paths: candidate.paths.sort(),
      }))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));

    return {
      scannedObjects: allPaths.length,
      ignoredObjects,
      candidates,
    };
  }

  /**
   * Run the repair. Apply mode deliberately inventories twice: the second scan
   * is the only one used for deletion, preventing a stale dry-run view from
   * becoming a destructive action.
   */
  async repair(apply = false): Promise<FileExplorerStorageRepairResult> {
    const initialInventory = await this.inventory();
    if (!apply) {
      return {
        applied: false,
        inventory: initialInventory,
        removedObjects: 0,
        removedPrefixes: [],
      };
    }

    const inventory = await this.inventory();
    const removedPrefixes: string[] = [];
    let removedObjects = 0;

    for (const candidate of inventory.candidates) {
      const removed = await this.storage.removePathsStrict(
        candidate.paths,
        candidate.prefix,
      );
      removedObjects += removed;
      removedPrefixes.push(candidate.prefix);
    }

    this.logger.log(
      `Removed ${removedObjects} object(s) from ${removedPrefixes.length} orphaned File Explorer prefix(es)`,
    );

    return {
      applied: true,
      inventory,
      removedObjects,
      removedPrefixes,
    };
  }

  private parseCanonicalPath(
    path: string,
  ): Pick<
    FileExplorerStorageRepairCandidate,
    'organizationId' | 'spaceId' | 'prefix'
  > | null {
    const parts = path.split('/');
    if (
      parts.length !== 6 ||
      !UUID_RE.test(parts[0]) ||
      parts[1] !== 'file-explorer' ||
      !UUID_RE.test(parts[2]) ||
      !UUID_RE.test(parts[3]) ||
      !UUID_RE.test(parts[4]) ||
      !parts[5]
    ) {
      return null;
    }

    return {
      organizationId: parts[0],
      spaceId: parts[2],
      prefix: `${parts[0]}/file-explorer/${parts[2]}`,
    };
  }

  private async findExistingOrganizations(ids: string[]): Promise<Set<string>> {
    const existing = new Set<string>();

    for (const batch of this.uniqueBatches(ids)) {
      const { data, error } = await this.db
        .from('organizations')
        .select('id')
        .in('id', batch);
      if (error) {
        throw new FileExplorerStorageRepairError(
          `Could not verify organizations: ${error.message}`,
        );
      }

      for (const row of (data ?? []) as { id: string }[]) existing.add(row.id);
    }

    return existing;
  }

  private async findExistingSpaces(ids: string[]): Promise<Set<string>> {
    const existing = new Set<string>();

    for (const batch of this.uniqueBatches(ids)) {
      const { data, error } = await this.db
        .from('spaces')
        .select('id, organization_id')
        .in('id', batch);
      if (error) {
        throw new FileExplorerStorageRepairError(
          `Could not verify spaces: ${error.message}`,
        );
      }

      for (const row of (data ?? []) as {
        id: string;
        organization_id: string;
      }[]) {
        existing.add(`${row.organization_id}:${row.id}`);
      }
    }

    return existing;
  }

  private uniqueBatches(values: string[]): string[][] {
    const unique = [...new Set(values)].sort();
    const batches: string[][] = [];
    for (let index = 0; index < unique.length; index += LOOKUP_BATCH_SIZE) {
      batches.push(unique.slice(index, index + LOOKUP_BATCH_SIZE));
    }
    return batches;
  }
}
