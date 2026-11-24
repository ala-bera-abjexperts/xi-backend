/**
 * @fileoverview Thin HTTP client to the on-prem update sidecar (xisuite-updater).
 * The sidecar owns the Docker socket + deploy repo and the .update-state files; the
 * backend never touches Docker or the shared volume directly — it only calls these
 * fixed, secret-authenticated endpoints over the internal network.
 * @module src/on-prem-updates/updater-client.service
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LogChunk,
  UpdateState,
} from './interfaces/update-state.interface';

type TriggerAction = 'check' | 'apply' | 'reinstall' | 'revert' | 'restore-db';

@Injectable()
export class UpdaterClientService {
  private readonly logger = new Logger(UpdaterClientService.name);
  private static readonly TIMEOUT_MS = 10_000;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('onPrem.updaterUrl') || '';
  }
  private get secret(): string {
    return this.config.get<string>('onPrem.updaterSecret') || '';
  }

  private async req(
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const base = this.baseUrl;
    if (!base) {
      throw new ServiceUnavailableException(
        'Update sidecar URL is not configured (UPDATE_AGENT_URL).',
      );
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-Update-Secret': this.secret,
        accept: 'application/json',
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(UpdaterClientService.TIMEOUT_MS),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  }

  /** Read state.json via the sidecar. On any transport error returns a synthetic
   * `deploy_unreachable` state so the UI can show a clear message (never throws). */
  async getStatus(): Promise<UpdateState> {
    try {
      const { status, body } = await this.req('GET', '/status');
      if (status === 401) {
        this.logger.error(
          'updater rejected status auth (check UPDATE_AGENT_SECRET)',
        );
        return { status: 'deploy_unreachable', updaterReachable: false };
      }
      return { ...(body as unknown as UpdateState), updaterReachable: true };
    } catch (e) {
      this.logger.warn(`updater /status unreachable: ${(e as Error).message}`);
      return { status: 'deploy_unreachable', updaterReachable: false };
    }
  }

  /** Read a slice of the current job log. Never throws (returns empty on error). */
  async getLogs(since: number): Promise<LogChunk> {
    try {
      const { body } = await this.req(
        'GET',
        `/logs?since=${encodeURIComponent(String(since))}`,
      );
      return {
        content: typeof body.content === 'string' ? body.content : '',
        nextOffset:
          typeof body.nextOffset === 'number' ? body.nextOffset : since,
        size: typeof body.size === 'number' ? body.size : 0,
      };
    } catch (e) {
      this.logger.debug(`updater /logs error: ${(e as Error).message}`);
      return { content: '', nextOffset: since, size: 0 };
    }
  }

  /** Fire a fixed action. Transport errors map to 503; the caller maps 409 -> busy.
   *
   * `query` carries the restore-db confirmation token only. The sidecar takes no other
   * parameters — the action set is a fixed allow-list on both sides, so nothing here can be
   * turned into arbitrary execution. */
  async trigger(
    action: TriggerAction,
    query?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return this.post(`/${action}${qs}`);
  }

  /** Server configuration (GET /config). Raw: throws 503 when no URL is set and lets
   * network errors through, so the caller can tell "disabled" from "unreachable". */
  getConfig(): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.req('GET', '/config');
  }

  /** Server configuration change (POST /config/apply). The body is the validated DTO;
   * the sidecar re-validates every key and value against the catalog. */
  applyConfig(
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.post('/config/apply', body);
  }

  private async post(
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      return await this.req('POST', path, json);
    } catch (e) {
      throw new ServiceUnavailableException(
        `Cannot reach the update service: ${(e as Error).message}`,
      );
    }
  }
}
