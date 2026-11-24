/**
 * @fileoverview Guards the two properties that make caching a decrypted archive safe.
 * @module src/backup/engine/restore-archive-cache.service.spec
 *
 * The cached object is a PLAINTEXT copy of an entire tenant, reachable by any restore of that backup
 * file rather than by one apply. Two things stop that from being a hole, and both are silent when
 * they break — which is why they are pinned here rather than left to review:
 *
 *   - **The passphrase is still proven.** `BackupArchivesService.openForDownload` is the only other
 *     place an archive passphrase is ever checked, and a cache hit skips that path entirely. If
 *     `verifyPassphrase` ever stopped throwing, holding `can_restore_backups` would be enough to
 *     restore an encrypted archive without knowing its passphrase, and every existing test would
 *     still pass.
 *   - **A stale or unverifiable entry is refused.** An expired copy, one that no longer matches the
 *     artifact, or one with no stored header must all read as a miss so the restore downloads from
 *     the target instead.
 *
 * The passphrase tests use REAL crypto rather than a stubbed cipher: the whole value of the check is
 * that it exercises the same scrypt derivation and GCM unwrap the download path does, so a stub
 * would assert nothing.
 */

import { ConfigService } from '@nestjs/config';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  ArchiveCipherError,
  type ArchiveHeader,
  buildArchiveHeader,
  deriveArchiveKek,
  newArchiveSalt,
  newDataKey,
} from '../crypto/archive-cipher';
import {
  type CachedArchiveEntry,
  RestoreArchiveCacheService,
} from './restore-archive-cache.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ARTIFACT = '22222222-2222-4222-8222-222222222222';
const PASSPHRASE = 'correct horse battery staple';

/** A real header, wrapped with a real key derived from `PASSPHRASE`. */
async function realHeader(): Promise<ArchiveHeader> {
  const salt = newArchiveSalt();
  const kek = await deriveArchiveKek(PASSPHRASE, salt);

  return buildArchiveHeader({ dek: newDataKey(), kek, salt });
}

function entryWith(
  header: ArchiveHeader | null,
  isEncrypted = true,
): CachedArchiveEntry {
  return { objectPath: `${ORG}/${ARTIFACT}.zip`, isEncrypted, header };
}

/**
 * The rows the fake table holds, and every call made against it.
 *
 * A chainable stub rather than a mocked query builder: the service awaits some chains directly
 * (`delete().eq().eq()`) and terminates others with `maybeSingle()`, so the object has to be both
 * thenable and chainable to be exercised at all.
 */
function clientWith(row: Record<string, unknown> | null) {
  const calls: string[] = [];

  const builder: Record<string, unknown> = {};
  const chain = () => builder;

  for (const method of ['select', 'eq', 'lt', 'limit', 'update', 'upsert']) {
    builder[method] = (...args: unknown[]) => {
      calls.push(`${method}(${args.length})`);

      return chain();
    };
  }

  builder.delete = () => {
    calls.push('delete');

    return chain();
  };

  builder.maybeSingle = () => Promise.resolve({ data: row, error: null });

  // Awaiting the chain itself — what `removeRow`, `lease` and `store` do.
  builder.then = (onOk: (v: unknown) => unknown, onErr?: unknown) =>
    Promise.resolve({ data: row ? [row] : [], error: null }).then(
      onOk,
      onErr as never,
    );

  const removed: string[][] = [];

  const client = {
    from: () => builder,
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          removed.push(paths);

          return Promise.resolve({ error: null });
        },
        download: () => Promise.resolve({ data: null, error: null }),
        list: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  };

  return { client, calls, removed };
}

function serviceWith(
  row: Record<string, unknown> | null,
  enabled = true,
): {
  service: RestoreArchiveCacheService;
  removed: string[][];
  calls: string[];
} {
  const { client, calls, removed } = clientWith(row);

  const service = new RestoreArchiveCacheService(
    { getClient: () => client } as unknown as SupabaseAdminService,
    {
      get: () => enabled,
    } as unknown as ConfigService,
  );

  return { service, removed, calls };
}

/** A row that is fresh, matching, and openable — the shape a hit must have. */
function freshRow(header: ArchiveHeader, overrides = {}) {
  return {
    object_path: `${ORG}/${ARTIFACT}.zip`,
    is_encrypted: true,
    archive_header: header,
    source_sha256: 'abc123',
    source_byte_size: 4096,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const MATCHING = { sha256: 'abc123', byteSize: 4096 };

describe('verifyPassphrase — the gate that replaces openForDownload on a cache hit', () => {
  it('accepts the passphrase that actually opens the archive', async () => {
    const { service } = serviceWith(null);

    await expect(
      service.verifyPassphrase(entryWith(await realHeader()), PASSPHRASE),
    ).resolves.toBeUndefined();
  });

  it('REFUSES a wrong passphrase', async () => {
    // The security test. Without this the cache would hand a whole tenant to anyone holding
    // `can_restore_backups`, because no other check on the restore path looks at the passphrase.
    const { service } = serviceWith(null);

    await expect(
      service.verifyPassphrase(entryWith(await realHeader()), 'not the one'),
    ).rejects.toThrow(ArchiveCipherError);
  });

  it('refuses an encrypted archive with no passphrase at all', async () => {
    const { service } = serviceWith(null);

    await expect(
      service.verifyPassphrase(entryWith(await realHeader()), undefined),
    ).rejects.toThrow(ArchiveCipherError);
  });

  it('refuses an encrypted archive whose header was never stored', async () => {
    // Fail closed. A null header means the passphrase CANNOT be checked, which must never be
    // read as "no check needed".
    const { service } = serviceWith(null);

    await expect(
      service.verifyPassphrase(entryWith(null), PASSPHRASE),
    ).rejects.toThrow(ArchiveCipherError);
  });

  it('asks nothing of an unencrypted archive', async () => {
    // Matches openForDownload, which serves a plain archive without a passphrase.
    const { service } = serviceWith(null);

    await expect(
      service.verifyPassphrase(entryWith(null, false), undefined),
    ).resolves.toBeUndefined();
  });
});

describe('lookup — what may be reused', () => {
  it('returns a fresh, matching, openable entry', async () => {
    const header = await realHeader();
    const { service } = serviceWith(freshRow(header));

    await expect(service.lookup(ORG, ARTIFACT, MATCHING)).resolves.toEqual({
      objectPath: `${ORG}/${ARTIFACT}.zip`,
      isEncrypted: true,
      header,
    });
  });

  it('treats an expired entry as a miss and deletes it', async () => {
    const header = await realHeader();
    const { service, removed } = serviceWith(
      freshRow(header, {
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
    );

    // Expiry is enforced here as well as in the cron, because the cron is gated on
    // `backup.schedulerEnabled` — off by default, which would otherwise mean never.
    await expect(service.lookup(ORG, ARTIFACT, MATCHING)).resolves.toBeNull();
    expect(removed).toEqual([[`${ORG}/${ARTIFACT}.zip`]]);
  });

  it('treats a checksum that no longer matches the artifact as a miss', async () => {
    const header = await realHeader();
    const { service, removed } = serviceWith(freshRow(header));

    // The file on the target was replaced. Serving the previous bytes would restore something the
    // operator never chose.
    await expect(
      service.lookup(ORG, ARTIFACT, { sha256: 'different', byteSize: 4096 }),
    ).resolves.toBeNull();
    expect(removed).toEqual([[`${ORG}/${ARTIFACT}.zip`]]);
  });

  it('falls back to size when neither side records a checksum', async () => {
    const header = await realHeader();
    const { service } = serviceWith(
      freshRow(header, { source_sha256: null, source_byte_size: 4096 }),
    );

    await expect(
      service.lookup(ORG, ARTIFACT, { sha256: null, byteSize: 4096 }),
    ).resolves.not.toBeNull();

    const stale = serviceWith(
      freshRow(header, { source_sha256: null, source_byte_size: 4096 }),
    );

    await expect(
      stale.service.lookup(ORG, ARTIFACT, { sha256: null, byteSize: 9999 }),
    ).resolves.toBeNull();
  });

  it('treats an encrypted entry with no stored header as a miss', async () => {
    const { service, removed } = serviceWith(
      freshRow(await realHeader(), { archive_header: null }),
    );

    // Re-downloading verifies the passphrase through the real path, which is the safe direction.
    await expect(service.lookup(ORG, ARTIFACT, MATCHING)).resolves.toBeNull();
    expect(removed).toEqual([[`${ORG}/${ARTIFACT}.zip`]]);
  });

  it('returns nothing at all when the cache is switched off', async () => {
    const { service, calls } = serviceWith(await realHeader(), false);

    // The rollback that does not need a deploy: off means a restore behaves exactly as it did
    // before this cache existed, without so much as a lookup.
    await expect(service.lookup(ORG, ARTIFACT, MATCHING)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the kill switch', () => {
  it('neither reads nor writes when disabled', async () => {
    const { service, calls } = serviceWith(null, false);

    await expect(
      service.store({
        organizationId: ORG,
        artifactId: ARTIFACT,
        localPath: '/tmp/nothing.zip',
        isEncrypted: false,
        header: null,
        identity: MATCHING,
      }),
    ).resolves.toBe(false);

    await expect(service.fetchLegacy(ORG, 'run-1')).resolves.toBeNull();
    await expect(service.evictExpired()).resolves.toBe(0);

    expect(calls).toEqual([]);
  });
});
