/**
 * @fileoverview Business logic for the On-Prem Updates feature. Wraps the updater
 * sidecar HTTP client, re-masks secrets at read time (defense-in-depth), maps the
 * sidecar's busy/error responses to clean HTTP semantics, and exposes an SSE stream
 * (status + incremental log) that resumes losslessly across browser refreshes and
 * backend restarts via a byte offset.
 * @module src/on-prem-updates/on-prem-updates.service
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { UpdaterClientService } from './updater-client.service';
import type {
  LogChunk,
  UpdateState,
} from './interfaces/update-state.interface';

/** Statuses at which a job is finished: the SSE stream completes and the daily check
 * cron trusts the result. */
export const TERMINAL = new Set<string>([
  'idle',
  'update_available',
  'no_update_available',
  'update_completed',
  'update_failed',
  'rollback_completed',
  'rollback_failed',
  'db_partially_migrated',
  // Migrations completed, then the update failed and the images were rolled back — so the
  // database is a release AHEAD of the code now serving it. Terminal: the agent has stopped and
  // is waiting on a human decision (restore the pre-update dump, or accept the mismatch).
  'schema_ahead_of_code',
  'restore_completed',
  'restore_failed',
  'deploy_unreachable',
  'registry_unavailable',
  'registry_unauthorized',
  'managed_externally',
  // Server configuration jobs: applied, rolled back to the previous overrides, or the
  // rollback itself failed.
  'config_applied',
  'config_rolled_back',
  'config_failed',
]);

@Injectable()
export class OnPremUpdatesService implements OnModuleInit {
  private readonly logger = new Logger(OnPremUpdatesService.name);

  constructor(
    private readonly updater: UpdaterClientService,
    private readonly config: ConfigService,
  ) {}

  /** On Kubernetes the cluster's own tooling upgrades the stack; no sidecar exists. */
  private get managedExternally(): boolean {
    return this.config.get<string>('onPrem.deployPlatform') === 'kubernetes';
  }

  onModuleInit(): void {
    if (this.managedExternally) return;
    // The module is only loaded on-prem; warn loudly if the updater coordinates
    // are missing so the operator isn't left wondering why updates always 503.
    if (!this.config.get<string>('onPrem.updaterUrl')) {
      this.logger.warn(
        'On-prem updates enabled but UPDATE_AGENT_URL is not set — update endpoints will report the service as unreachable.',
      );
    }
    if (!this.config.get<string>('onPrem.updaterSecret')) {
      this.logger.warn(
        'On-prem updates enabled but UPDATE_AGENT_SECRET is not set — the updater will reject all calls.',
      );
    }
  }

  async getStatus(): Promise<UpdateState> {
    if (this.managedExternally) {
      // updaterReachable=false also keeps the daily update-notice cron quiet.
      return {
        status: 'managed_externally',
        updaterReachable: false,
        release: this.config.get<string>('onPrem.release') || '',
      };
    }
    const s = await this.updater.getStatus();
    if (s.error) s.error = this.mask(s.error);
    if (!s.release) s.release = this.config.get<string>('onPrem.release') || '';
    // Defensive: a sidecar-provided top-level `message` would be hijacked by the
    // global ResponseInterceptor as the envelope message — strip it.
    delete (s as unknown as Record<string, unknown>).message;
    return s;
  }

  async getLogs(since: number): Promise<LogChunk> {
    const chunk = await this.updater.getLogs(since);
    return { ...chunk, content: this.mask(chunk.content) };
  }

  async check(): Promise<{ accepted: boolean }> {
    const r = await this.updater.trigger('check');
    return { accepted: r.status === 202 || r.status === 200 };
  }

  async apply(): Promise<{ accepted: boolean }> {
    const r = await this.updater.trigger('apply');
    if (r.status === 409) {
      throw new ConflictException(
        (r.body?.message as string) ||
          'An update or rollback is already running.',
      );
    }
    if (r.status >= 500) {
      throw new ServiceUnavailableException(
        'The update service failed to start the update.',
      );
    }
    return { accepted: r.status === 202 };
  }

  async reinstall(): Promise<{ accepted: boolean }> {
    // The sidecar derives and pins the currently running release. No version is
    // accepted from the API caller, so this cannot become a downgrade selector.
    const r = await this.updater.trigger('reinstall');
    if (r.status === 400) {
      throw new BadRequestException(
        (r.body?.message as string) ||
          'The current release cannot be reinstalled safely.',
      );
    }
    if (r.status === 409) {
      throw new ConflictException(
        (r.body?.message as string) ||
          'An update or rollback is already running.',
      );
    }
    if (r.status !== 202) {
      throw new ServiceUnavailableException(
        'The update service failed to start the reinstall.',
      );
    }
    return { accepted: true };
  }

  async revert(): Promise<{ accepted: boolean }> {
    const r = await this.updater.trigger('revert');
    if (r.status === 409) {
      throw new ConflictException(
        (r.body?.message as string) ||
          'An update or rollback is already running.',
      );
    }
    if (r.status >= 500) {
      throw new ServiceUnavailableException(
        'The update service failed to start the revert.',
      );
    }
    return { accepted: r.status === 202 };
  }

  /**
   * Restore the pre-update database dump.
   *
   * The only destructive operation this service exposes, and it exists for one specific
   * situation: an update whose migrations succeeded and whose health checks then failed. The
   * images roll back automatically; the schema cannot, so the box ends up running older code
   * against a newer schema (`schema_ahead_of_code`).
   *
   * `confirm` must be the exact basename of the backup named in the current state. The sidecar
   * re-derives that name from its own state and compares — this is a confirmation, never a
   * selector, so it cannot be pointed at another file. The agent additionally refuses unless the
   * status actually calls for a restore.
   */
  async restoreDb(confirm: string): Promise<{ accepted: boolean }> {
    if (!confirm?.trim()) {
      throw new BadRequestException(
        'Restoring the database requires the backup filename as confirmation.',
      );
    }
    const r = await this.updater.trigger('restore-db', {
      confirm: confirm.trim(),
    });
    if (r.status === 400) {
      throw new BadRequestException(
        (r.body?.message as string) ||
          'The confirmation did not match the backup filename.',
      );
    }
    if (r.status === 409) {
      throw new ConflictException(
        (r.body?.message as string) ||
          'A database restore is not available in the current state.',
      );
    }
    if (r.status >= 500) {
      throw new ServiceUnavailableException(
        'The update service failed to start the database restore.',
      );
    }
    return { accepted: r.status === 202 };
  }

  /**
   * Server-Sent Events stream. Polls the sidecar for state + new log bytes every
   * 1.5s (mirrors the AutomationRuns streamRun pattern) and emits:
   *   { type: 'log',    content, offset }
   *   { type: 'status', state }
   *   { type: 'done',   state }
   * The client passes `?since=<byteOffset>` to resume after a refresh/restart.
   */
  stream(since: number): Observable<{ data: unknown }> {
    return new Observable<{ data: unknown }>((subscriber) => {
      let active = true;
      let offset = Number.isFinite(since) && since >= 0 ? since : 0;
      let lastStatus = '';

      const flushLogs = async (): Promise<void> => {
        const logs = await this.getLogs(offset);
        if (logs.content) {
          subscriber.next({
            data: {
              type: 'log',
              content: logs.content,
              offset: logs.nextOffset,
            },
          });
          offset = logs.nextOffset;
        }
      };

      const poll = async (): Promise<void> => {
        while (active) {
          const state = await this.getStatus();
          await flushLogs();
          if (state.status !== lastStatus) {
            lastStatus = String(state.status);
            subscriber.next({ data: { type: 'status', state } });
          }
          if (TERMINAL.has(String(state.status))) {
            await flushLogs(); // drain any trailing log lines before closing
            subscriber.next({ data: { type: 'done', state } });
            subscriber.complete();
            active = false;
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      };

      poll().catch((err: unknown) => subscriber.error(err));
      return () => {
        active = false;
      };
    });
  }

  // --- read-time secret masking (defense-in-depth; sidecar also masks at write) ---
  private literals(): string[] {
    return [
      this.config.get<string>('onPrem.updaterSecret'),
      this.config.get<string>('supabase.serviceRoleKey'),
      this.config.get<string>('supabase.jwtSecret'),
      this.config.get<string>('supabase.anonKey'),
    ].filter((v): v is string => !!v && v.length >= 6);
  }

  private mask(text: string): string {
    if (!text) return text;
    let out = text;
    for (const v of this.literals()) out = out.split(v).join('***REDACTED***');
    out = out.replace(
      /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
      '***JWT_REDACTED***',
    );
    out = out.replace(
      /postgres(?:ql)?:\/\/[^@\s]+@[^\s]+/g,
      'postgres://***REDACTED***',
    );
    out = out.replace(
      /([A-Za-z0-9_]*(?:password|passwd|token|secret|api[_-]?key))(\s*[=:]\s*)(\S+)/gi,
      (_m, k: string, sep: string) => `${k}${sep}***REDACTED***`,
    );
    return out;
  }
}
