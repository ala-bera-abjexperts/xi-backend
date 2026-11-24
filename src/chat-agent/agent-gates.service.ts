/**
 * @fileoverview The gates in front of Robert (XE-T353, ROB-01, ADM-01): is the AI
 * feature licensed, may this person use Robert, is he switched on, is a provider
 * configured. One answer for the client (`GET /chat/agent/status`) and one for the
 * backend before it starts a run, so the two can never disagree.
 * @module src/chat-agent/agent-gates.service
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatConversationRow } from '../chat/chat-access.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AgentRefusalCode } from './agent-runs.repository';
import { AgentSettingsService } from './agent-settings.service';
import { isAgentDmKey, ROBERT_ID } from './agent.constants';

export type AgentState =
  | 'ok'
  | 'not_configured'
  | 'not_licensed'
  | 'no_permission'
  | 'disabled';

export interface AgentStatusView {
  state: AgentState;
  /** The tenant's AI provider (`openai`, `anthropic`, …); null when none is configured. */
  provider: string | null;
  /** May Robert be mentioned in direct messages (his own conversation always works). */
  dmAllowed: boolean;
  robertId: string;
}

@Injectable()
export class AgentGatesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly entitlements: EntitlementsService,
    private readonly permissions: PermissionsService,
    private readonly settings: AgentSettingsService,
  ) {}

  /**
   * Whether Robert is usable by this person here. First failing gate wins, in this
   * order: AI feature licensed, `can_use_robert`, Robert enabled, provider configured.
   */
  async status(user: RequestUser): Promise<AgentStatusView> {
    const [entitlements, permitted, settings, provider] = await Promise.all([
      this.entitlements.getEffectiveEntitlements(user.organizationId),
      this.permissions.checkPermission(
        user.userId,
        user.organizationId,
        'can_use_robert',
      ),
      this.settings.read(user.organizationId),
      this.configuredProvider(user.organizationId),
    ]);

    return {
      state: !entitlements.has('feature_ai_assist')
        ? 'not_licensed'
        : !permitted
          ? 'no_permission'
          : !settings.enabled
            ? 'disabled'
            : !provider
              ? 'not_configured'
              : 'ok',
      provider,
      dmAllowed: settings.allowInDms,
      robertId: ROBERT_ID,
    };
  }

  /**
   * The gate check before a run starts: the refusal code to store with
   * agent_start_run (`p_refusal`), or null when Robert may answer. Order: not
   * impersonating, licensed, permitted, enabled, allowed in this DM, configured.
   * The database function checks the rest (read-only, rate limit, budgets).
   *
   * @param conversation where Robert was mentioned; without it the DM rule is left
   *   to the database function
   */
  async refusal(
    user: RequestUser,
    conversation?: Pick<ChatConversationRow, 'kind' | 'dm_key'>,
  ): Promise<AgentRefusalCode | null> {
    if (user.impersonation) return 'impersonating';

    const { state, dmAllowed } = await this.status(user);

    if (state !== 'ok' && state !== 'not_configured') return state;
    if (
      !dmAllowed &&
      conversation?.kind === 'dm' &&
      !isAgentDmKey(conversation.dm_key)
    ) {
      return 'dm_disabled';
    }

    return state === 'not_configured' ? state : null;
  }

  /**
   * The provider of the organization's AI configuration, or null when there is
   * none or it is switched off: the rule of TenantAiService.resolveConfig, without
   * loading the key.
   */
  private async configuredProvider(
    organizationId: string,
  ): Promise<string | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('ai_provider_configs')
      .select('provider_name, is_active')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException(
        'Could not load the AI configuration',
      );

    const row = data as {
      provider_name: string;
      is_active: boolean | null;
    } | null;

    return row && row.is_active !== false ? row.provider_name : null;
  }
}
