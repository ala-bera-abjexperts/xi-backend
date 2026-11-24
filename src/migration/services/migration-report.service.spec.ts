/**
 * @fileoverview Failure grouping in the run report.
 *
 * A customer's run failed 214 items for ONE reason, and the operator could not
 * tell — the UI showed a bare count and a scrolling log pane. The report now
 * collapses failures to their distinct causes, which only works if the volatile
 * parts of an error message are masked first: the TipTap validator names a JSON
 * path (`... at $.content[0].content[3].marks[0].attrs.href`) that differs per
 * page, so grouping on the raw text produces one group per item and reproduces
 * the log it was meant to replace.
 * @module src/migration/services/migration-report.service.spec
 */

import { Logger } from '@nestjs/common';
import type { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  MigrationReportService,
  maskVolatileDetail,
} from './migration-report.service';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

describe('maskVolatileDetail', () => {
  it('collapses TipTap validator errors that differ only by JSON path', () => {
    const a =
      'Invalid TipTap document at $.content[0].content[0].content[1].marks[0].attrs.href: URL is empty';
    const b =
      'Invalid TipTap document at $.content[7].content[2].marks[0].attrs.href: URL is empty';

    expect(maskVolatileDetail(a)).toBe(maskVolatileDetail(b));
    expect(maskVolatileDetail(a)).toContain('URL is empty');
  });

  it('keeps genuinely different causes apart', () => {
    const empty =
      'Invalid TipTap document at $.content[0].marks[0].attrs.href: URL is empty';
    const scheme =
      'Invalid TipTap document at $.content[0].marks[0].attrs.href: URL scheme "javascript" is not allowed';

    expect(maskVolatileDetail(empty)).not.toBe(maskVolatileDetail(scheme));
  });

  it('masks uuids so per-item ids do not fragment a group', () => {
    const a = 'Parent 11111111-2222-4333-8444-555555555555 did not migrate';
    const b = 'Parent 99999999-8888-4777-8666-555555555555 did not migrate';

    expect(maskVolatileDetail(a)).toBe(maskVolatileDetail(b));
  });

  it('masks quoted names so per-page titles do not fragment a group', () => {
    const a = 'Attachment "Anzahlung_beistellung.pdf" could not be downloaded';
    const b = 'Attachment "Rechnung_2026.pdf" could not be downloaded';

    expect(maskVolatileDetail(a)).toBe(maskVolatileDetail(b));
  });

  it('masks bare numbers', () => {
    expect(maskVolatileDetail('Page 214 failed')).toBe(
      maskVolatileDetail('Page 3 failed'),
    );
  });

  it('leaves a message with nothing volatile untouched', () => {
    expect(maskVolatileDetail('Adapter has no Confluence read surface')).toBe(
      'Adapter has no Confluence read surface',
    );
  });

  /**
   * The whole point, stated as one assertion: the customer's 214 failures must
   * come out as ONE cause, not 214.
   */
  it('reduces the customer-shaped failure set to a single cause', () => {
    const messages = Array.from(
      { length: 214 },
      (_, i) =>
        `Wiki page content rejected: Invalid TipTap document at $.content[${i}].content[1].marks[0].attrs.href: URL is empty`,
    );

    expect(new Set(messages.map(maskVolatileDetail)).size).toBe(1);
  });
});

describe('MigrationReportService mapped-target lookup', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('never sends a non-uuid target id to a lookup and still resolves', async () => {
    const db = harness(
      [
        item('cf-uuid', 'custom_field', UUID_A),
        item('cf-skip', 'custom_field', 'skip', 'skipped'),
        item('cf-native', 'custom_field', 'native:priority', 'skipped'),
        item('cf-key', 'custom_field', 'story_points', 'skipped'),
        item('group', 'custom_field', 'groups:2'),
      ],
      { custom_fields: [UUID_A] },
    );

    const report = await service(db).getReport('org-1', 'run-1');

    expect(db.lookups.flatMap((l) => l.ids)).toEqual([UUID_A]);
    // Non-uuid targets are unverifiable, like a null target: not counted as mapped.
    expect(report.entities).toEqual([
      expect.objectContaining({ entityType: 'custom_field', mapped: 1 }),
    ]);
  });

  it('degrades one failing table to unverified instead of 404ing the report', async () => {
    const db = harness(
      [
        item('task', 'task', UUID_A),
        item('field', 'custom_field', UUID_B),
        item('space', 'space', UUID_C),
      ],
      { tasks: [UUID_A], spaces: [UUID_C] },
      'custom_fields',
    );

    const report = await service(db).getReport('org-1', 'run-1');
    const mapped = Object.fromEntries(
      report.entities.map((e) => [e.entityType, e.mapped]),
    );

    expect(mapped).toEqual({ custom_field: 0, space: 1, task: 1 });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('custom_fields'),
    );
  });
});

function item(
  id: string,
  entity_type: string,
  target_id: string,
  status = 'succeeded',
) {
  return {
    id,
    stage: entity_type,
    stage_order: 1,
    entity_type,
    item_kind: 'entity',
    source_ref: id,
    parent_source_ref: null,
    payload: null,
    status,
    retry_count: 0,
    target_id,
    error_class: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: '2026-09-01T00:00:00.000Z',
  };
}

function service(db: ReturnType<typeof harness>) {
  const admin = {
    getClient: () => ({ from: (table: string) => db.query(table) }),
  } as unknown as SupabaseAdminService;
  return new MigrationReportService(admin, {} as PdfRenderService);
}

/** Minimal PostgREST stand-in: target tables return the seeded live ids; `failTable` errors. */
function harness(
  items: ReturnType<typeof item>[],
  live: Record<string, string[]>,
  failTable?: string,
) {
  const lookups: { table: string; ids: string[] }[] = [];
  const query = (table: string) => {
    let ids: string[] = [];
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      range: () => q,
      in: (column: string, values: string[]) => {
        if (column === 'id') {
          ids = values;
          lookups.push({ table, ids: values });
        }
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({
          data: { id: 'run-1', job_id: 'job-1', mode: 'live', status: 'x' },
          error: null,
        }),
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'migration_run_items')
          return Promise.resolve({ data: items, error: null }).then(resolve);
        if (table === failTable)
          return Promise.resolve({
            data: null,
            error: { message: 'invalid input syntax for type uuid' },
          }).then(resolve);
        const data = (live[table] ?? [])
          .filter((id) => ids.includes(id))
          .map((id) => ({ id }));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return q;
  };
  return { query, lookups };
}
