/**
 * @fileoverview One-time heal for Jira attachment links that earlier imports left on Jira (XE-T668).
 *
 * The relink stage used to resolve files only within the run and job that imported the issue, so a
 * file that arrived in a retry, a re-run or a repair kept its `src`/`href` on the source Jira although
 * the bytes were copied. On the first boot of a release carrying this service, every Jira-imported
 * task whose description or comments still carry a Jira attachment URL is relinked with the stage's
 * own logic (crosswalk, origin gate, sanitizer, compare-and-swap write), so customers are healed by
 * updating, without re-running a migration. Native tasks are never read: the scan starts from the
 * issue crosswalk. A `cron_run_state` marker makes it run once per database; a pass that hit an error
 * leaves no marker and resumes on the next boot. Replicas racing each other are harmless — the write
 * only lands when the content is still exactly what was read.
 *
 * @module src/migration/engine/jira-attachment-relink-heal.service
 * @author Prince Jadiya
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { isMigrationEngineDisabled } from './migration-cron.service';
import { ISSUE_ENTITY } from './stages/issues.stage';
import {
  JiraAttachmentRelinkStage,
  type RelinkScope,
} from './stages/jira-attachment-relink.stage';
import { MigrationItemError } from './stages/stage.interface';

export const JIRA_ATTACHMENT_RELINK_HEAL_MARKER =
  'migration.jira_attachment_relink_heal.v1';

/** Lets the boot finish (and a rolling update settle) before scanning. */
const START_DELAY_MS = 60_000;
/** Issue crosswalk rows per page; keeps every `.in()` list of task ids short. */
const PAGE = 50;
/** PostgREST's default row cap — a comment read that hits it may be missing tasks. */
const MAX_ROWS = 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Jira Server and Cloud attachment URL shapes, as the transformer recognises them. */
const JIRA_LINK_PATTERNS = [
  'secure/attachment/',
  'secure/thumbnail/',
  'attachment/content/',
  'attachment/thumbnail/',
];

function jiraLinkFilter(column: string): string {
  return JIRA_LINK_PATTERNS.map(
    (pattern) => `${column}.ilike.*${pattern}*`,
  ).join(',');
}

interface HealTotals {
  tasks: number;
  updated: number;
  failed: number;
}

@Injectable()
export class JiraAttachmentRelinkHealService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(JiraAttachmentRelinkHealService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly relinkStage: JiraAttachmentRelinkStage,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  onApplicationBootstrap(): void {
    if (isMigrationEngineDisabled()) return;

    this.timer = setTimeout(() => void this.run(), START_DELAY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Never throws: a heal that cannot finish simply runs again on the next boot. */
  async run(): Promise<void> {
    try {
      if (await this.alreadyHealed()) return;

      const passId = `heal:${Date.now()}`;
      const totals: HealTotals = { tasks: 0, updated: 0, failed: 0 };

      for (const connection of await this.jiraConnections()) {
        await this.healConnection(connection, passId, totals);
      }

      const summary = `${totals.updated} of ${totals.tasks} task(s) with Jira attachment links relinked`;

      if (totals.failed > 0) {
        this.logger.warn(
          `Jira attachment link heal incomplete (${summary}, ${totals.failed} failed); retrying on next boot`,
        );

        return;
      }

      await this.markHealed();
      this.logger.log(`Jira attachment link heal done: ${summary}`);
    } catch (err) {
      this.logger.error(
        `Jira attachment link heal stopped, retrying on next boot: ${(err as Error).message}`,
      );
    }
  }

  private async healConnection(
    connection: { id: string; organization_id: string },
    passId: string,
    totals: HealTotals,
  ): Promise<void> {
    const scope: RelinkScope = {
      orgId: connection.organization_id,
      connectionId: connection.id,
      passId,
      log: (level, message) => {
        if (level === 'warn' || level === 'error') this.logger.warn(message);

        return Promise.resolve();
      },
    };
    let after: string | null = null;

    for (;;) {
      let query = this.db
        .from('migration_entity_map')
        .select('source_id, source_key, target_id')
        .eq('organization_id', connection.organization_id)
        .eq('source_connection_id', connection.id)
        .eq('entity_type', ISSUE_ENTITY)
        .eq('status', 'mapped');

      if (after) query = query.gt('source_id', after);

      const { data, error } = (await query
        .order('source_id', { ascending: true })
        .limit(PAGE)) as {
        data:
          | {
              source_id: string;
              source_key: string | null;
              target_id: string;
            }[]
          | null;
        error: { message: string } | null;
      };

      if (error)
        throw new Error(`issue crosswalk read failed: ${error.message}`);

      const rows = data ?? [];

      if (rows.length === 0) return;

      after = rows[rows.length - 1].source_id;

      const issueKeys = new Map(
        rows
          .filter((row) => UUID_RE.test(row.target_id))
          .map((row) => [row.target_id, row.source_key ?? row.source_id]),
      );

      for (const taskId of await this.tasksWithJiraLinks(
        connection.organization_id,
        [...issueKeys.keys()],
      )) {
        totals.tasks++;

        try {
          const outcome = await this.relinkStage.relinkTask(
            scope,
            taskId,
            issueKeys.get(taskId)!,
          );

          if (outcome.kind === 'updated') totals.updated++;
        } catch (err) {
          // A task deleted mid-pass can never be relinked; anything else is worth another boot.
          if (
            err instanceof MigrationItemError &&
            err.errorClass === 'conflict'
          ) {
            continue;
          }

          totals.failed++;
          this.logger.warn(
            `Jira attachment link heal: task ${taskId} failed: ${(err as Error).message}`,
          );
        }
      }

      if (rows.length < PAGE) return;
    }
  }

  /** The page's tasks whose description or any comment still carries a Jira attachment URL. */
  private async tasksWithJiraLinks(
    orgId: string,
    taskIds: string[],
  ): Promise<string[]> {
    if (taskIds.length === 0) return [];

    const [tasks, comments] = (await Promise.all([
      this.db
        .from('tasks')
        .select('id')
        .eq('organization_id', orgId)
        .in('id', taskIds)
        .or(jiraLinkFilter('description')),
      this.db
        .from('task_comments')
        .select('task_id')
        .eq('organization_id', orgId)
        .in('task_id', taskIds)
        .or(jiraLinkFilter('content')),
    ])) as {
      data: { id?: string; task_id?: string }[] | null;
      error: { message: string } | null;
    }[];

    if (tasks.error)
      throw new Error(`task scan failed: ${tasks.error.message}`);
    if (comments.error)
      throw new Error(`comment scan failed: ${comments.error.message}`);

    // A capped comment read may hide tasks; relinking the whole page is a cheap no-op for the rest.
    if ((comments.data ?? []).length >= MAX_ROWS) return taskIds;

    return [
      ...new Set([
        ...(tasks.data ?? []).map((row) => row.id!),
        ...(comments.data ?? []).map((row) => row.task_id!),
      ]),
    ];
  }

  private async jiraConnections(): Promise<
    { id: string; organization_id: string }[]
  > {
    const { data, error } = (await this.db
      .from('migration_connections')
      .select('id, organization_id')
      .eq('product', 'jira')) as {
      data: { id: string; organization_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) throw new Error(`connection read failed: ${error.message}`);

    return data ?? [];
  }

  private async alreadyHealed(): Promise<boolean> {
    const { data, error } = (await this.db
      .from('cron_run_state')
      .select('job_name')
      .eq('job_name', JIRA_ATTACHMENT_RELINK_HEAL_MARKER)
      .maybeSingle()) as {
      data: { job_name: string } | null;
      error: { message: string } | null;
    };

    if (error) throw new Error(`heal marker read failed: ${error.message}`);

    return !!data;
  }

  /** INSERT: a duplicate key just means another replica finished first. */
  private async markHealed(): Promise<void> {
    const { error } = (await this.db.from('cron_run_state').insert({
      job_name: JIRA_ATTACHMENT_RELINK_HEAL_MARKER,
      last_run_at: new Date().toISOString(),
    })) as { error: { message: string; code?: string } | null };

    if (error && error.code !== '23505') {
      throw new Error(`heal marker write failed: ${error.message}`);
    }
  }
}
