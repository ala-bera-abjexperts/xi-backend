/**
 * @fileoverview Server configuration (the server-wide `client.conf` env) for on-prem
 * installs. A thin pass-through to the updater sidecar, which owns the catalog, the
 * validation, the overrides file and the apply/rollback job. The backend only decides
 * whether the sidecar can be used, maps its errors to HTTP and writes the audit row.
 * Secret values never pass through here: the sidecar returns only `{set, hint}`.
 * @module src/on-prem-config/on-prem-config.service
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { UpdaterClientService } from '../on-prem-updates/updater-client.service';
import type { ApplyServerConfigDto } from './dto/apply-server-config.dto';

export type ServerConfigUnavailableReason =
  | 'kubernetes'
  | 'updater_disabled'
  | 'updater_unreachable';

@Injectable()
export class OnPremConfigService {
  private readonly logger = new Logger(OnPremConfigService.name);

  constructor(
    private readonly updater: UpdaterClientService,
    private readonly config: ConfigService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** The sidecar `GET /config` body, or `{available:false, reason}` (never throws). */
  async getConfig(): Promise<Record<string, unknown>> {
    const unavailable = (reason: ServerConfigUnavailableReason) => ({
      available: false,
      reason,
    });
    // Kubernetes: the cluster's own tooling owns the env and there is no sidecar.
    if (this.config.get<string>('onPrem.deployPlatform') === 'kubernetes') {
      return unavailable('kubernetes');
    }
    if (!this.config.get<string>('onPrem.updaterUrl')) {
      return unavailable('updater_disabled');
    }
    try {
      const { status, body } = await this.updater.getConfig();
      if (status !== 200) {
        // 401 (secret mismatch), 5xx, or a 404 from a sidecar older than this feature.
        this.logger.warn(`updater GET /config returned ${status}`);
        return unavailable('updater_unreachable');
      }
      // A top-level `message` would be taken over as the envelope message.
      delete body.message;
      return body;
    } catch (e) {
      this.logger.warn(`updater /config unreachable: ${(e as Error).message}`);
      return unavailable('updater_unreachable');
    }
  }

  async apply(
    user: RequestUser,
    dto: ApplyServerConfigDto,
  ): Promise<{ accepted: boolean; action: unknown; keys: unknown }> {
    const set = dto.set ?? {};
    const reset = dto.reset ?? [];
    const { status, body } = await this.updater.applyConfig({
      revision: dto.revision,
      set,
      reset,
    });
    const error = typeof body.error === 'string' ? body.error : undefined;
    const message = typeof body.message === 'string' ? body.message : undefined;

    // The global exception filter forwards only `message`, `code` and `data`, so the
    // sidecar's `error`/`fields` travel as `code` and inside `data`.
    if (status === 400) {
      throw new BadRequestException({
        message: message || 'The configuration change was rejected.',
        code: error,
        data: { error, fields: body.fields ?? null },
      });
    }
    if (status === 409) {
      throw new ConflictException({
        message:
          message ||
          (error === 'stale_revision'
            ? 'The configuration changed elsewhere. Reload and try again.'
            : 'Another update or configuration change is running.'),
        code: error,
        data: { error },
      });
    }
    if (status !== 202) {
      throw new ServiceUnavailableException(
        'The update service failed to apply the configuration.',
      );
    }

    // Key NAMES only, never values. entity_id is a uuid column, so the org id.
    void this.auditLogs.logActionForRequest(
      user,
      'server_config',
      user.organizationId,
      'update',
      { keys: Object.keys(set), reset },
    );
    return { accepted: true, action: body.action, keys: body.keys };
  }
}
