/**
 * @fileoverview P11 — the run report. Assembles what a migration ACTUALLY did, per entity, from the
 * three records the engine already keeps, and renders it as JSON or CSV.
 *
 * Deliberately a READER, not a second source of truth:
 *  - `migration_run_items` — the work units and their terminal states.
 *  - `migration_entity_map` — optional current-run target-table/match-method enrichment.
 *  - `migration_logs` — the lossy warnings stages emit when fidelity degraded.
 *  - `run.totals.verification` — the source-vs-target reconciliation `verify.stage.ts` already
 *    writes. Its `EntityReconciliation` shape is reused verbatim rather than recomputed, so the
 *    report and the verify stage can never disagree.
 *
 * The point of this report is the LOSSY section. Counts tell you a run finished; only the lossy
 * lines tell you what it cost. This project's signature failure is content that vanishes while the
 * numbers look right — a report without the warnings would be exactly that failure, formatted.
 *
 * Service-role bypasses RLS, so every query hand-scopes `organization_id`.
 *
 * @module src/migration/services/migration-report.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { EntityReconciliation } from '../engine/stages/verify.stage';
import type { MigrationRunRow } from '../engine/stages/stage.interface';
import {
  renderMigrationReportCsv,
  renderMigrationReportHtml,
  sanitizeAuditText,
} from './migration-report.renderer';

const RUNS = 'migration_runs';
const ITEMS = 'migration_run_items';
const MAP = 'migration_entity_map';
const LOGS = 'migration_logs';
const PAGE_SIZE = 1000;
const PDF_PAGE = { widthPx: 1123, heightPx: 794 } as const;
const CONTROL_ENTITY_TYPES = new Set(['probe', 'verification']);
/**
 * Target ids are not always uuids: custom_fields stores crosswalk values (`skip`, `native:<x>`, a
 * field_key) and other stages store composite keys (`groups:3`). One such value in an `.in('id')`
 * raises 22P02 and 404s the whole report, so only uuids are looked up.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLUMNS =
  'id, stage, stage_order, entity_type, item_kind, source_ref, parent_source_ref, payload, status, retry_count, target_id, error_class, error_message, started_at, finished_at, duration_ms, created_at';
const REPORT_TARGET_TABLES: Readonly<Record<string, string>> = {
  space: 'spaces',
  issue: 'tasks',
  watcher: 'task_watchers',
  task: 'tasks',
  comment: 'task_comments',
  attachment: 'file_attachments',
  page: 'wiki_pages',
  confluence_page_watcher: 'wiki_watches',
  confluence_space_watcher: 'wiki_watches',
  page_attachment: 'wiki_page_attachments',
  page_comment: 'wiki_page_comments',
  status_category: 'status_categories',
  task_status: 'task_statuses',
  custom_field: 'custom_fields',
  workflow: 'workflows',
  workflow_assignment: 'workflow_assignments',
  board: 'boards',
  history: 'tasks',
  jira_attachment_relink: 'tasks',
};

/** Affected items listed per failure group. Enough to investigate, not a dump. */
const SAMPLES_PER_GROUP = 25;

/**
 * Strip the parts of an error message that differ per item, so the same defect
 * collapses into one group instead of N.
 */
export function maskVolatileDetail(message: string): string {
  return (
    message
      // TipTap validator JSON paths: `$.content[0].content[3].marks[0].attrs.href`
      .replace(/\$[.\w[\]]*/g, '<path>')
      // UUIDs
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '<id>',
      )
      // Quoted names (page titles, filenames)
      .replace(/"[^"]*"/g, '"<name>"')
      // Bare numbers (ids, sizes, offsets)
      .replace(/\b\d+\b/g, '<n>')
      .trim()
  );
}

/** One entity type's outcome across the whole run. */
export interface EntityReportRow {
  entityType: string;
  created: number;
  skipped: number;
  failed: number;
  blocked: number;
  planned: number;
  /** Distinct successful/skipped live-run items with a durable target id. */
  mapped: number;
}

export interface LossyEntry {
  sourceRef?: string;
  macroName?: string;
  reason?: string;
  stage: string | null;
  message: string;
  at: string;
}

/**
 * Failed items collapsed to their distinct CAUSES.
 *
 * A run that fails 214 items usually fails them for one or two reasons, but the
 * operator only ever saw a scrolling log and a bare count — a customer's 214
 * failures were all a single bad anchor and nobody could tell. Grouping is done
 * here, server-side, because the item table runs to ~10k rows.
 */
export interface FailureGroup {
  entityType: string;
  /** transient | rate_limited | permanent | conflict, or null on older rows. */
  errorClass: string | null;
  /** The error text with volatile detail masked, so like causes group together. */
  cause: string;
  count: number;
  /** A bounded sample of affected source items, for the operator to go and look at. */
  samples: { sourceRef: string | null; title: string | null }[];
}

export interface MigrationReport {
  runId: string;
  jobId: string;
  mode: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Canonical stages this build had no handler for — work that was NEVER attempted. */
  unimplementedStages: string[];
  entities: EntityReportRow[];
  /** Source-vs-target reconciliation from the verify stage; empty when it did not run. */
  reconciliation: EntityReconciliation[];
  /** Every fidelity loss a stage reported. The most important section. */
  lossy: LossyEntry[];
  /** Distinct reasons items failed, most frequent first. Empty when nothing failed. */
  failures: FailureGroup[];
  totals: { created: number; skipped: number; failed: number; blocked: number };
}

interface ItemRow {
  id: string;
  stage: string;
  stage_order: number;
  entity_type: string;
  item_kind: 'collection' | 'entity';
  status: string;
  retry_count: number;
  error_class: string | null;
  error_message: string | null;
  source_ref: string | null;
  parent_source_ref: string | null;
  payload: Record<string, unknown> | null;
  target_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface MappingRow {
  entity_type: string;
  source_id: string;
  target_table: string | null;
  target_id: string;
  match_method: string | null;
}

export interface MigrationAuditRow {
  skipReason?: string;
  stage: string;
  entityType: string;
  itemKind: 'collection' | 'entity';
  sourceRef: string | null;
  titleOrFilename: string | null;
  parentSourceRef: string | null;
  outcome: string;
  matchMethod: string | null;
  targetTable: string | null;
  targetIdOrKey: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorClass: string | null;
  errorMessage: string | null;
}

export interface MigrationReportExport {
  report: MigrationReport;
  items: MigrationAuditRow[];
}

export interface MigrationAuditPage {
  items: MigrationAuditRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface MigrationAuditFilters {
  status?: string;
  stage?: string;
  entity_type?: string;
  item_kind?: 'collection' | 'entity';
  limit?: number;
  offset?: number;
}

@Injectable()
export class MigrationReportService {
  private readonly logger = new Logger(MigrationReportService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly pdfRenderService: PdfRenderService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async getReport(orgId: string, runId: string): Promise<MigrationReport> {
    return (await this.getExport(orgId, runId)).report;
  }

  async getExport(
    orgId: string,
    runId: string,
  ): Promise<MigrationReportExport> {
    const run = await this.loadRun(orgId, runId);
    const [items, mappings, lossy, skipReasons] = await Promise.all([
      this.loadItems(orgId, runId),
      this.loadMappings(orgId, runId),
      this.loadLossy(orgId, runId),
      this.loadHistorySkipReasons(orgId, runId),
    ]);
    const mapped = await this.mappedCounts(items, run.mode, orgId);

    const byEntity = new Map<string, EntityReportRow>();
    const row = (entityType: string): EntityReportRow => {
      let r = byEntity.get(entityType);

      if (!r) {
        r = {
          entityType,
          created: 0,
          skipped: 0,
          failed: 0,
          blocked: 0,
          planned: 0,
          mapped: mapped.get(entityType) ?? 0,
        };
        byEntity.set(entityType, r);
      }

      return r;
    };

    for (const item of items) {
      if (
        item.item_kind !== 'entity' ||
        CONTROL_ENTITY_TYPES.has(item.entity_type)
      ) {
        continue;
      }
      const r = row(item.entity_type);

      // `succeeded` covers created/updated/planned — the item table records the lifecycle, not the
      // outcome kind, so it is counted as work that completed.
      if (item.status === 'succeeded') r.created += 1;
      else if (item.status === 'skipped') r.skipped += 1;
      else if (item.status === 'failed' || item.status === 'dead')
        r.failed += 1;
      else if (item.status === 'blocked') r.blocked += 1;
    }

    const entities = [...byEntity.values()].sort((a, b) =>
      a.entityType.localeCompare(b.entityType),
    );
    const snapshot = (run.config_snapshot ?? {}) as {
      unimplemented_stages?: unknown;
    };
    const totalsRaw = (run.totals ?? {}) as {
      verification?: { reconciliations?: EntityReconciliation[] };
    };

    const report: MigrationReport = {
      runId: run.id,
      jobId: run.job_id,
      mode: run.mode,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: run.duration_ms,
      unimplementedStages: Array.isArray(snapshot.unimplemented_stages)
        ? snapshot.unimplemented_stages
            .filter(isString)
            .map((stage) => sanitizeAuditText(stage, 128))
        : [],
      entities,
      reconciliation: totalsRaw.verification?.reconciliations ?? [],
      lossy,
      // Collection/control failures stay visible here and in the audit trail, but never enter the
      // business entity counters above.
      failures: this.groupFailures(items),
      totals: {
        created: entities.reduce((s, e) => s + e.created, 0),
        skipped: entities.reduce((s, e) => s + e.skipped, 0),
        failed: entities.reduce((s, e) => s + e.failed, 0),
        blocked: entities.reduce((s, e) => s + e.blocked, 0),
      },
    };
    const mappingBySource = this.mappingBySource(mappings);

    return {
      report,
      items: items.map((item) =>
        projectAuditRow(
          item,
          this.mappingFor(mappingBySource, item),
          ['history', 'page_history'].includes(item.stage) &&
            item.status === 'skipped'
            ? skipReasons.get(item.source_ref ?? '')
            : undefined,
        ),
      ),
    };
  }

  async listItems(
    orgId: string,
    runId: string,
    filters: MigrationAuditFilters,
  ): Promise<MigrationAuditPage> {
    await this.loadRun(orgId, runId);
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;
    let query = this.db
      .from(ITEMS)
      .select(ITEM_COLUMNS, { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('run_id', runId)
      .order('stage_order', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.stage) query = query.eq('stage', filters.stage);
    if (filters.entity_type)
      query = query.eq('entity_type', filters.entity_type);
    if (filters.item_kind) query = query.eq('item_kind', filters.item_kind);

    const { data, error, count } = (await query) as {
      data: ItemRow[] | null;
      error: { message: string } | null;
      count: number | null;
    };

    if (error)
      throw new NotFoundException(`Item load failed: ${error.message}`);

    const rows = data ?? [];
    const sourceIds = [
      ...new Set(rows.map((item) => item.source_ref).filter(isString)),
    ];
    const mappings = await this.loadMappings(orgId, runId, sourceIds);
    const skipReasons = await this.loadHistorySkipReasons(orgId, runId);
    const mappingBySource = this.mappingBySource(mappings);

    return {
      items: rows.map((item) =>
        projectAuditRow(
          item,
          this.mappingFor(mappingBySource, item),
          ['history', 'page_history'].includes(item.stage) &&
            item.status === 'skipped'
            ? skipReasons.get(item.source_ref ?? '')
            : undefined,
        ),
      ),
      total: count ?? 0,
      limit,
      offset,
    };
  }

  /** UTF-8, deterministic report with the complete projected audit trail. */
  toCsv(bundle: MigrationReportExport): string {
    return renderMigrationReportCsv(bundle);
  }

  async toPdf(bundle: MigrationReportExport): Promise<Buffer> {
    return this.pdfRenderService.renderPdf(this.toHtml(bundle), PDF_PAGE);
  }

  toHtml(bundle: MigrationReportExport): string {
    return renderMigrationReportHtml(bundle);
  }

  private async loadRun(
    orgId: string,
    runId: string,
  ): Promise<MigrationRunRow> {
    const { data, error } = (await this.db
      .from(RUNS)
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', runId)
      .maybeSingle()) as {
      data: MigrationRunRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new NotFoundException(`Run lookup failed: ${error.message}`);
    if (!data) throw new NotFoundException('Run not found');

    return data;
  }

  /**
   * Collapse failed items to their distinct causes, most frequent first.
   *
   * The message is MASKED before grouping. Without that, a validator error that
   * names a JSON path (`... at $.content[0].content[3].marks[0].attrs.href`)
   * produces one group per item and the summary is just the log again. Ids,
   * quoted names and numbers get the same treatment for the same reason.
   */
  private groupFailures(items: ItemRow[]): FailureGroup[] {
    const groups = new Map<string, FailureGroup>();

    for (const item of items) {
      if (item.status !== 'failed' && item.status !== 'dead') continue;

      const cause = maskVolatileDetail(
        sanitizeAuditText(item.error_message ?? 'Unknown error'),
      );
      const key = `${item.entity_type}|${item.error_class ?? ''}|${cause}`;
      let group = groups.get(key);

      if (!group) {
        group = {
          entityType: item.entity_type,
          errorClass: item.error_class,
          cause,
          count: 0,
          samples: [],
        };
        groups.set(key, group);
      }

      group.count += 1;

      // Bounded: the operator needs somewhere to start looking, not all 214.
      if (group.samples.length < SAMPLES_PER_GROUP) {
        group.samples.push({
          sourceRef: auditNullable(item.source_ref, 500),
          title:
            item.entity_type === 'user'
              ? null
              : auditNullable(titleOrFilename(item.payload), 500),
        });
      }
    }

    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  private async loadItems(orgId: string, runId: string): Promise<ItemRow[]> {
    const out: ItemRow[] = [];

    // Paged: a 9,826-issue run has ~10k item rows and PostgREST caps a default select.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = (await this.db
        .from(ITEMS)
        .select(ITEM_COLUMNS)
        .eq('organization_id', orgId)
        .eq('run_id', runId)
        .order('stage_order', { ascending: true })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)) as {
        data: ItemRow[] | null;
        error: { message: string } | null;
      };

      if (error)
        throw new NotFoundException(`Item load failed: ${error.message}`);

      const rows = data ?? [];

      out.push(...rows);

      if (rows.length < PAGE_SIZE) break;
    }

    return out;
  }

  /**
   * Crosswalk enrichment is run-scoped. The map is mutable across reruns, so an old item's durable
   * target_id remains authoritative and target-table/match-method stay blank once that provenance
   * has moved; borrowing a newer run's metadata would make the historical report incorrect.
   */
  private async loadMappings(
    orgId: string,
    runId: string,
    sourceIds?: string[],
  ): Promise<MappingRow[]> {
    if (sourceIds && sourceIds.length === 0) return [];

    const out: MappingRow[] = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = this.db
        .from(MAP)
        .select('entity_type, source_id, target_table, target_id, match_method')
        .eq('organization_id', orgId)
        .eq('run_id', runId)
        .order('entity_type', { ascending: true })
        .order('source_id', { ascending: true })
        .order('id', { ascending: true });

      if (sourceIds) query = query.in('source_id', sourceIds);

      const { data, error } = (await query.range(
        offset,
        offset + PAGE_SIZE - 1,
      )) as {
        data: MappingRow[] | null;
        error: { message: string } | null;
      };

      if (error)
        throw new NotFoundException(`Crosswalk load failed: ${error.message}`);

      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }

    return out;
  }

  private async mappedCounts(
    items: ItemRow[],
    mode: MigrationRunRow['mode'],
    orgId: string,
  ): Promise<Map<string, number>> {
    const sourcesByEntity = new Map<string, Set<string>>();

    if (mode !== 'live') return new Map();

    const candidates = items.filter(
      (item) =>
        item.item_kind === 'entity' &&
        !CONTROL_ENTITY_TYPES.has(item.entity_type) &&
        (item.status === 'succeeded' || item.status === 'skipped') &&
        item.target_id !== null,
    );
    const targetIdsByTable = new Map<string, Set<string>>();

    for (const item of candidates) {
      const table = REPORT_TARGET_TABLES[item.entity_type];
      // A non-uuid target is unverifiable by row lookup: like a null target, it is not counted.
      if (!table || !UUID_RE.test(item.target_id!)) continue;
      const ids = targetIdsByTable.get(table) ?? new Set<string>();
      ids.add(item.target_id!);
      targetIdsByTable.set(table, ids);
    }

    const existingByTable = new Map<string, Set<string>>();

    for (const [table, ids] of targetIdsByTable) {
      try {
        existingByTable.set(
          table,
          await this.loadExistingTargetIds(orgId, table, [...ids]),
        );
      } catch (err) {
        // One table's lookup failing must not 404 the whole report: its rows stay unverified
        // (not counted as mapped) and every other table still reports.
        this.logger.warn(
          `Mapped target lookup skipped for ${table}: ${(err as Error).message}`,
        );
      }
    }

    for (const item of candidates) {
      const table = REPORT_TARGET_TABLES[item.entity_type];
      if (table && !existingByTable.get(table)?.has(item.target_id!)) continue;

      const sources =
        sourcesByEntity.get(item.entity_type) ?? new Set<string>();
      sources.add(item.source_ref ?? item.id);
      sourcesByEntity.set(item.entity_type, sources);
    }

    return new Map(
      [...sourcesByEntity].map(([entityType, sources]) => [
        entityType,
        sources.size,
      ]),
    );
  }

  private mappingBySource(mappings: MappingRow[]): Map<string, MappingRow> {
    return new Map(
      mappings.map((mapping) => [
        `${mapping.entity_type}\u0000${mapping.source_id}`,
        mapping,
      ]),
    );
  }

  private mappingFor(
    mappings: Map<string, MappingRow>,
    item: ItemRow,
  ): MappingRow | undefined {
    if (item.source_ref === null) return undefined;
    return mappings.get(`${item.entity_type}\u0000${item.source_ref}`);
  }

  /** Every `warn`/`error` a stage logged — the fidelity record. */
  private async loadLossy(orgId: string, runId: string): Promise<LossyEntry[]> {
    const rows: LossyEntry[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await this.db
        .from(LOGS)
        .select('stage, message, created_at, level, source_ref, context')
        .eq('organization_id', orgId)
        .eq('run_id', runId)
        .in('level', ['warn', 'error'])
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error)
        throw new NotFoundException(`Log load failed: ${error.message}`);
      const page = data ?? [];
      rows.push(
        ...page.map((log) => {
          const context = log.context ?? {};
          const diagnostics = {
            sourceRef:
              typeof context.sourceRef === 'string'
                ? context.sourceRef
                : log.source_ref,
            macroName: context.macroName,
            reason: context.reason,
          };
          return {
            stage: log.stage,
            message: sanitizeAuditText(log.message),
            at: log.created_at,
            ...Object.fromEntries(
              Object.entries(diagnostics)
                .filter(([, value]) => typeof value === 'string')
                .map(([key, value]) => [
                  key,
                  sanitizeAuditText(value as string, 1000),
                ]),
            ),
          };
        }),
      );
      if (page.length < PAGE_SIZE) return rows;
    }
  }

  private async loadHistorySkipReasons(
    orgId: string,
    runId: string,
  ): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await this.db
        .from(LOGS)
        .select('source_ref, context')
        .eq('organization_id', orgId)
        .eq('run_id', runId)
        .in('stage', ['history', 'page_history'])
        .in('level', ['info', 'warn'])
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error)
        throw new NotFoundException(
          `History diagnostics load failed: ${error.message}`,
        );
      const page = data ?? [];
      for (const log of page) {
        const sourceRef =
          typeof log.context?.sourceRef === 'string'
            ? log.context.sourceRef
            : log.source_ref;
        if (
          typeof sourceRef === 'string' &&
          typeof log.context?.reason === 'string'
        ) {
          reasons.set(sourceRef, sanitizeAuditText(log.context.reason, 1000));
        }
      }
      if (page.length < PAGE_SIZE) return reasons;
    }
  }

  private async loadExistingTargetIds(
    orgId: string,
    table: string,
    targetIds: string[],
  ): Promise<Set<string>> {
    if (table === 'wiki_page_attachments' || table === 'wiki_page_comments') {
      return this.loadExistingWikiChildTargetIds(orgId, table, targetIds);
    }

    if (table === 'spaces') {
      return this.loadExistingSpaceTargetIds(orgId, targetIds);
    }

    if (table === 'wiki_pages') {
      return this.loadExistingWikiPageTargetIds(orgId, targetIds);
    }

    const existing = new Set<string>();

    for (let offset = 0; offset < targetIds.length; offset += 200) {
      const { data, error } = (await this.db
        .from(table)
        .select('id')
        .eq('organization_id', orgId)
        .in('id', targetIds.slice(offset, offset + 200))) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new NotFoundException(
          `Mapped target lookup failed for ${table}: ${error.message}`,
        );
      }

      for (const row of data ?? []) existing.add(row.id);
    }

    return existing;
  }

  private async loadExistingSpaceTargetIds(
    orgId: string,
    targetIds: string[],
  ): Promise<Set<string>> {
    const existing = new Set<string>();

    for (let offset = 0; offset < targetIds.length; offset += 200) {
      const { data, error } = (await this.db
        .from('spaces')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_archived', false)
        .in('id', targetIds.slice(offset, offset + 200))) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new NotFoundException(
          `Mapped target lookup failed for spaces: ${error.message}`,
        );
      }

      for (const row of data ?? []) existing.add(row.id);
    }

    return existing;
  }

  private async loadExistingWikiPageTargetIds(
    orgId: string,
    targetIds: string[],
  ): Promise<Set<string>> {
    const existing = new Set<string>();

    for (let offset = 0; offset < targetIds.length; offset += 200) {
      const { data, error } = (await this.db
        .from('wiki_pages')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_archived', false)
        .in('id', targetIds.slice(offset, offset + 200))) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new NotFoundException(
          `Mapped target lookup failed for wiki_pages: ${error.message}`,
        );
      }

      for (const row of data ?? []) existing.add(row.id);
    }

    return existing;
  }

  private async loadExistingWikiChildTargetIds(
    orgId: string,
    table: 'wiki_page_attachments' | 'wiki_page_comments',
    targetIds: string[],
  ): Promise<Set<string>> {
    const targetByPage = new Map<string, string[]>();

    for (let offset = 0; offset < targetIds.length; offset += 200) {
      const { data, error } = (await this.db
        .from(table)
        .select('id, wiki_page_id')
        .in('id', targetIds.slice(offset, offset + 200))) as {
        data: { id: string; wiki_page_id: string | null }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new NotFoundException(
          `Mapped target lookup failed for ${table}: ${error.message}`,
        );
      }

      for (const row of data ?? []) {
        if (!row.wiki_page_id) continue;
        const ids = targetByPage.get(row.wiki_page_id) ?? [];
        ids.push(row.id);
        targetByPage.set(row.wiki_page_id, ids);
      }
    }

    const livePageIds = new Set<string>();
    const pageIds = [...targetByPage.keys()];

    for (let offset = 0; offset < pageIds.length; offset += 200) {
      const { data, error } = (await this.db
        .from('wiki_pages')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_archived', false)
        .in('id', pageIds.slice(offset, offset + 200))) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new NotFoundException(
          `Mapped parent page lookup failed for ${table}: ${error.message}`,
        );
      }

      for (const row of data ?? []) livePageIds.add(row.id);
    }

    const existing = new Set<string>();

    for (const pageId of livePageIds) {
      for (const targetId of targetByPage.get(pageId) ?? []) {
        existing.add(targetId);
      }
    }

    return existing;
  }
}

/** The single allowlist projector consumed by the API, CSV, and PDF paths. */
export function projectAuditRow(
  item: ItemRow,
  mapping?: MappingRow,
  skipReason?: string,
): MigrationAuditRow {
  return {
    ...(skipReason ? { skipReason } : {}),
    stage: sanitizeAuditText(item.stage, 128),
    entityType: sanitizeAuditText(item.entity_type, 128),
    itemKind: item.item_kind,
    sourceRef: auditNullable(item.source_ref, 500),
    titleOrFilename:
      item.entity_type === 'user'
        ? null
        : auditNullable(titleOrFilename(item.payload), 500),
    parentSourceRef: auditNullable(item.parent_source_ref, 500),
    outcome: sanitizeAuditText(item.status, 64),
    matchMethod: auditNullable(mapping?.match_method ?? null, 128),
    targetTable: auditNullable(mapping?.target_table ?? null, 128),
    targetIdOrKey: auditNullable(
      mapping?.target_id ?? item.target_id ?? null,
      500,
    ),
    attempts: item.retry_count + (item.started_at === null ? 0 : 1),
    startedAt: item.started_at,
    finishedAt: item.finished_at,
    durationMs: item.duration_ms,
    errorClass: auditNullable(item.error_class, 128),
    errorMessage: auditNullable(item.error_message, 1000),
  };
}

function titleOrFilename(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;

  for (const key of ['title', 'summary', 'filename', 'fileName'] as const) {
    if (typeof payload[key] === 'string') return payload[key];
  }

  const attachment = payload.attachment;
  if (
    attachment !== null &&
    typeof attachment === 'object' &&
    typeof (attachment as Record<string, unknown>).filename === 'string'
  ) {
    return (attachment as Record<string, unknown>).filename as string;
  }

  return null;
}

function auditNullable(value: string | null, maxLength: number): string | null {
  return value === null ? null : sanitizeAuditText(value, maxLength);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
