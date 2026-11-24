/**
 * @fileoverview Tenant-facing licence status and manual re-check for on-prem.
 * @module on-prem-license/on-prem-license.controller
 *
 * Author: Prince Jadiya
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OnPremGuard } from '../on-prem-updates/guards/on-prem.guard';
import { OnpremLicensePollService } from './onprem-license-poll.service';
import { OnpremLicenseStateRepository } from './onprem-license-state.repository';
import { OnpremLicenseStateService } from './onprem-license.service';

@ApiTags('On-Prem Licence')
@ApiBearerAuth()
@UseGuards(OnPremGuard, RolesGuard)
@RequireRoles('owner', 'admin')
@ImpersonationBlocked()
@Controller('system-license')
export class OnPremLicenseController {
  constructor(
    private readonly state: OnpremLicenseStateService,
    private readonly poll: OnpremLicensePollService,
    private readonly repo: OnpremLicenseStateRepository,
  ) {}

  /**
   * Current licence state. Safe to poll from the UI: it re-verifies the stored
   * artifact locally and makes no outbound call.
   */
  @Get('status')
  async status() {
    const s = await this.state.evaluate();
    const row = await this.repo.get();
    const id = await this.state.identity(row);

    return {
      entitled: s.entitled,
      readOnly: s.readOnly,
      reason: s.reason,
      provisional: s.provisional,
      graceEndsAt: s.graceEndsAt,
      expiresAt: s.expiresAt,
      planKey: s.payload?.planKey ?? null,
      status: s.payload?.status ?? null,
      installationId: row?.installation_id ?? null,
      fingerprint: id.fingerprint,
      // An exported request file is waiting for its licence file.
      requestPending: !!row?.pending_nonce,
      // Last automatic/manual check-in and why it failed (null on success), so
      // an admin can see the cause without reading server logs.
      lastAttemptAt: row?.last_attempt_at ?? null,
      lastError: row?.last_error ? row.last_error.slice(0, 300) : null,
    };
  }

  /**
   * Minimal licence mode for EVERY member (the app-wide read-only banner).
   * Reveals nothing sensitive; the full status above stays owner/admin only.
   */
  @Get('mode')
  @RequireRoles('owner', 'admin', 'member', 'viewer')
  async mode() {
    const s = await this.state.current();

    return {
      readOnly: s.readOnly,
      provisional: s.provisional,
      graceEndsAt: s.graceEndsAt,
    };
  }

  /**
   * Air-gapped activation, step 1: the signed licence-request file to upload
   * in the cloud (partner portal or XISUITE). Remembers its nonce; only the
   * licence file issued for this exact request can be imported afterwards.
   */
  @Get('request')
  async request() {
    return this.state.buildRequest();
  }

  /**
   * "Check for renewal". Forces an immediate poll rather than waiting for the
   * next scheduled tick, so a customer who has just renewed does not have to
   * sit out the remaining window.
   *
   * Intentionally does NOT bypass verification or grant anything by itself: it
   * only asks the vendor again. A customer clicking it repeatedly achieves
   * nothing beyond what the cron already does.
   */
  @Post('check')
  @HttpCode(200)
  async check() {
    const result = await this.poll.poll();
    const s = await this.state.evaluate();

    return {
      outcome: result.outcome,
      detail: result.detail ?? null,
      entitled: s.entitled,
      reason: s.reason,
      expiresAt: s.expiresAt,
    };
  }

  /**
   * Manual activation for fully air-gapped installs, which can never poll.
   *
   * Accepts the identical signed artifact the poll would have fetched, so there
   * is exactly one verifier and one format. `expectedNonce` is null here
   * because an imported file has no request to echo; replay protection for this
   * path comes from the artifact's own signed expiry instead.
   */
  @Post('import')
  @HttpCode(200)
  async importArtifact(@Body() body: { artifact: unknown }) {
    // When a request file was exported, the licence file must answer THAT
    // request (its nonce), so an old or foreign file cannot be replayed.
    const row = await this.repo.get();
    const result = await this.poll.acceptArtifact(
      body?.artifact,
      row?.pending_nonce ?? null,
      'import',
    );
    const s = await this.state.evaluate();

    return {
      outcome: result.outcome,
      detail: result.detail ?? null,
      entitled: s.entitled,
      reason: s.reason,
      expiresAt: s.expiresAt,
    };
  }
}
