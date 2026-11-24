// Inbound-mailbox poll state — CRUD only, mirroring AutomationScheduleService.
//
// Lives in AutomationsModule rather than the inbound-email module because the
// publish/pause/resume paths call it; putting it in the consumer module would
// make AutomationsModule depend on a module that already depends on it.
// The polling loop itself lives in src/inbound-email.

import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IAutomationMailboxPoller } from './interfaces/automation.interface';

// Floor and default for mailbox polling. Graph throttles hard and IMAP servers
// rate-limit, so anything tighter than this reads as our bug.
export const MIN_POLL_INTERVAL_SECONDS = 60;

export interface MailboxPollerUpsertInput {
  automation_id: string;
  space_id: string;
  organization_id: string;
  connection_id: string;
  folder: string;
  poll_interval_seconds: number;
  watermark_at: string;
  is_active: boolean;
}

@Injectable()
export class AutomationMailboxPollerService {
  private readonly logger = new Logger(AutomationMailboxPollerService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async getByAutomation(
    automationId: string,
  ): Promise<IAutomationMailboxPoller | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_mailbox_pollers')
      .select('*')
      .eq('automation_id', automationId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      this.logger.error(`getByAutomation failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to get mailbox poller');
    }

    return data as IAutomationMailboxPoller | null;
  }

  /**
   * Upsert the poll row for an automation. Verifies the connection belongs to
   * the same space first — a background loop has no controller-level space
   * check, so a wrong connection id would otherwise poll another tenant's
   * mailbox. Mirrors the space guard in AutomationConnectionsService.revoke.
   */
  async upsert(
    input: MailboxPollerUpsertInput,
  ): Promise<IAutomationMailboxPoller> {
    const { data: conn, error: connError } = await this.db
      .from('automation_connections')
      .select('id, space_id, provider, is_revoked')
      .eq('id', input.connection_id)
      .maybeSingle();

    if (connError || !conn) {
      throw new NotFoundException('Mailbox connection not found');
    }
    if ((conn.space_id as string) !== input.space_id) {
      throw new BadRequestException(
        'Mailbox connection belongs to a different space',
      );
    }
    if (conn.is_revoked) {
      throw new BadRequestException('Mailbox connection has been revoked');
    }

    // One mailbox, one automation. The ledger dedupes per connection, so a
    // second automation on the same mailbox would lose every conflicting insert
    // and silently never create a ticket. Fail at publish instead.
    const { data: rival } = await this.db
      .from('automation_mailbox_pollers')
      .select('automation_id')
      .eq('connection_id', input.connection_id)
      .neq('automation_id', input.automation_id)
      .limit(1);

    if ((rival ?? []).length > 0) {
      throw new BadRequestException(
        'Another automation in this space is already reading this mailbox. ' +
          'Use a different mailbox, or edit the existing automation.',
      );
    }

    const { data: existingRow } = await this.db
      .from('automation_mailbox_pollers')
      .select('connection_id, folder, watermark_at')
      .eq('automation_id', input.automation_id)
      .maybeSingle();

    const existing = existingRow as {
      connection_id: string;
      folder: string;
      watermark_at: string;
    } | null;

    // Re-publishing must not move the watermark. It is the "only mail after this
    // point" cursor, so restamping it on every publish silently discards every
    // message that arrived since — including the one being tested with. Only a
    // genuinely different mailbox or folder starts a fresh window.
    const keepsWatermark =
      existing !== null &&
      existing.connection_id === input.connection_id &&
      existing.folder === input.folder;

    const row = {
      ...input,
      watermark_at: keepsWatermark
        ? (existing as { watermark_at: string }).watermark_at
        : input.watermark_at,
      poll_interval_seconds: Math.max(
        MIN_POLL_INTERVAL_SECONDS,
        input.poll_interval_seconds,
      ),
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_mailbox_pollers')
      .upsert(row, { onConflict: 'automation_id' })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`upsert failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to upsert mailbox poller');
    }

    return data as IAutomationMailboxPoller;
  }

  async deactivate(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_mailbox_pollers')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`deactivate failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to deactivate mailbox poller',
      );
    }
  }

  /**
   * Re-arm after a pause. The watermark is re-stamped to now so a month-long
   * pause does not ingest a month of backlog on resume.
   * Throws NotFoundException when the automation has no poller — callers use
   * the same `.catch()` pattern as scheduleService.activate.
   */
  async activate(automationId: string): Promise<void> {
    const poller = await this.getByAutomation(automationId);

    if (!poller)
      throw new NotFoundException('No mailbox poller for this automation');

    const { error } = await this.db
      .from('automation_mailbox_pollers')
      .update({
        is_active: true,
        watermark_at: new Date().toISOString(),
        delta_cursor: null,
        last_error: null,
        lease_until: null,
        worker_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`activate failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to activate mailbox poller',
      );
    }
  }

  async deleteByAutomation(automationId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_mailbox_pollers')
      .delete()
      .eq('automation_id', automationId);

    if (error) {
      this.logger.error(`delete failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to delete mailbox poller');
    }
  }
}
