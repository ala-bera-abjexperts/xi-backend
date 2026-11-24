import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WIKI_USER_COLUMNS, withFullName } from '../wiki/wiki-user.util';
import type { TimerAction } from './dto/whiteboard-live.dto';
import { WhiteboardsService, archivedError } from './whiteboards.service';

/** Same lifetime as the wiki's collab token; the client refreshes it before it runs out. */
const LIVE_TOKEN_TTL_SECONDS = 600;

/** The rail's live events. Clients only ever refetch on them (never trust the payload). */
export type WhiteboardLiveEvent =
  | 'timer_changed'
  | 'private_mode_changed'
  | 'comments_changed'
  | 'scene_changed';

export function liveTopic(whiteboardId: string): string {
  return `whiteboard:${whiteboardId}`;
}

/** Element deltas: every viewer may read it, only editors may write (`whiteboard_edit_topics`). */
export function sceneTopic(whiteboardId: string): string {
  return `whiteboard:${whiteboardId}:scene`;
}

export interface TimerState {
  /** `ended`: a running timer whose end has passed (not stored, derived on read). */
  status: 'idle' | 'running' | 'paused' | 'ended';
  duration_ms: number;
  ends_at: string | null;
  remaining_ms: number | null;

  /** Time "+1 min" added since the start: the countdown's total is duration_ms + added_ms. */
  added_ms: number;
  updated_at: string | null;

  /** The server's clock at the time of the answer: clients count from it, not their own clock. */
  server_now: string;
}

interface TimerRow {
  status: 'idle' | 'running' | 'paused';
  duration_ms: number;
  ends_at: string | null;
  remaining_ms: number | null;
  added_ms: number;
  updated_at: string | null;
}

export interface PrivateModeState {
  active: {
    id: string;
    keep_anonymous: boolean;
    started_at: string;

    /** Who started it; null in an anonymous session. */
    started_by_user: Record<string, unknown> | null;
  } | null;
}

/** Default duration offered before anyone has used the timer on a board (Confluence: 30:00). */
const DEFAULT_TIMER_MS = 30 * 60 * 1000;

/** The actions that carry a duration (whiteboard_timer_command ignores it on the others). */
const TIMED_ACTIONS: readonly TimerAction[] = ['start', 'set', 'resume'];

/**
 * The board's live layer: the private Realtime channel token, server-sent change events, the
 * shared timer and private mode. State lives in the tables of migrations 20261006150000,
 * 20261006150100 and 20261006150300, which only the service role can reach; every route checks
 * the Whiteboards module, the board's Share ACL and (for writes) that the board is not archived.
 */
@Injectable()
export class WhiteboardLiveService {
  private readonly logger = new Logger(WhiteboardLiveService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly whiteboards: WhiteboardsService,
    private readonly auditLogs: AuditLogsService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Guard ─────────────────────────────────────────────────────────────────

  /**
   * Module on in the space, the board's Share setting allows `level`, the board exists in the
   * caller's org, and (`write`) it is not archived. Archived boards stay readable.
   */
  async resolveBoard(
    user: RequestUser,
    spaceId: string,
    whiteboardId: string,
    level: 'can_view' | 'can_edit',
    write: boolean,
  ): Promise<void> {
    await this.whiteboards.assertAvailable(user.organizationId, spaceId);
    await this.whiteboards.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      level,
    );

    const { data, error } = await this.client
      .from('whiteboards')
      .select('is_archived')
      .eq('id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw this.dbError('load whiteboard', error);
    if (!data) throw new NotFoundException('Whiteboard not found');
    if (write && (data as { is_archived: boolean }).is_archived) {
      throw archivedError();
    }
  }

  // ── Live channel ──────────────────────────────────────────────────────────

  /**
   * Short-lived Realtime JWT for the board's private channel (presence + cursors). Same
   * mechanics as WikiCollabService.mintToken, but its own claim (`whiteboard_topics`), so it opens
   * only this board's topic and never a wiki one (policies of migration 20261006150000). The
   * scene topic is readable by all, writable only when `canEditScene`.
   */
  async mintToken(
    user: RequestUser,
    whiteboardId: string,
    canEditScene: boolean,
  ): Promise<{
    token: string;
    topic: string;
    scene_topic: string;
    can_edit_scene: boolean;
    expires_at: string;
    server_now: string;
  }> {
    const secret = this.config.get<string>('supabase.jwtSecret');

    if (!secret) {
      throw new ServiceUnavailableException(
        'Realtime collaboration is not configured',
      );
    }

    // sub must be the auth.users id (Realtime treats it as the auth uid).
    let authUserId = user.authUserId;

    if (!authUserId) {
      const { data } = await this.client
        .from('users')
        .select('auth_user_id')
        .eq('id', user.userId)
        .maybeSingle();

      authUserId =
        (data as { auth_user_id?: string } | null)?.auth_user_id ?? '';
    }

    if (!authUserId) {
      throw new BadRequestException('Could not resolve auth identity');
    }

    const topic = liveTopic(whiteboardId);
    const scene = sceneTopic(whiteboardId);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const expSec = nowSec + LIVE_TOKEN_TTL_SECONDS;

    const token = await this.jwt.signAsync(
      {
        iss: 'xisuite-backend',
        sub: authUserId,
        role: 'authenticated',
        aud: 'authenticated',
        iat: nowSec,
        exp: expSec,
        whiteboard_topics: [topic],
        whiteboard_scene_topics: [scene],
        whiteboard_edit_topics: canEditScene ? [scene] : [],
        app_user_id: user.userId,
        org_id: user.organizationId,
      },
      { secret, algorithm: 'HS256' },
    );

    return {
      token,
      topic,
      scene_topic: scene,
      can_edit_scene: canEditScene,
      expires_at: new Date(expSec * 1000).toISOString(),
      server_now: new Date(nowMs).toISOString(),
    };
  }

  /**
   * Tells everyone on the board that `event` state changed. Best effort (a lost event only means
   * a later refetch): failures are logged, never thrown. Service-role REST broadcast, like
   * WikiCollabBroadcastService, on the board's private topic.
   */
  async broadcast(
    whiteboardId: string,
    event: WhiteboardLiveEvent,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const url = this.config.get<string>('SUPABASE_URL', '').replace(/\/$/, '');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY', '');

    if (!url || !key) return;

    try {
      const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              topic: liveTopic(whiteboardId),
              event,
              payload: { at: new Date().toISOString(), ...payload },
              private: true,
            },
          ],
        }),
      });

      if (!res.ok) {
        this.logger.warn(
          `[Broadcast] HTTP ${res.status} for ${liveTopic(whiteboardId)} (${event})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[Broadcast] Failed for ${liveTopic(whiteboardId)} (${event}): ${String(err)}`,
      );
    }
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  async getTimer(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
  ): Promise<TimerState> {
    const { data, error } = await this.client
      .from('whiteboard_timers')
      .select(
        'status, duration_ms, ends_at, remaining_ms, added_ms, updated_at',
      )
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw this.dbError('load timer', error);

    return toTimerState(
      (data as TimerRow | null) ?? {
        status: 'idle',
        duration_ms: DEFAULT_TIMER_MS,
        ends_at: null,
        remaining_ms: null,
        added_ms: 0,
        updated_at: null,
      },
      new Date(),
    );
  }

  /** One atomic command (whiteboard_timer_command serializes concurrent clicks). */
  async commandTimer(
    user: RequestUser,
    spaceId: string,
    whiteboardId: string,
    action: TimerAction,
    durationMs?: number,
  ): Promise<TimerState> {
    const { data, error } = (await this.client.rpc('whiteboard_timer_command', {
      p_whiteboard_id: whiteboardId,
      p_space_id: spaceId,
      p_organization_id: user.organizationId,
      p_user_id: user.userId,
      p_action: action,
      p_duration_ms: TIMED_ACTIONS.includes(action)
        ? (durationMs ?? null)
        : null,
    })) as { data: unknown; error: { code?: string; message: string } | null };

    if (error) {
      if (error.code === '22023') throw new BadRequestException(error.message);
      if (error.code === 'P0002' || error.code === '23503') {
        throw new NotFoundException('Whiteboard not found');
      }
      throw this.dbError('update timer', error);
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | (TimerRow & { server_now: string })
      | undefined;

    if (!row) throw this.dbError('update timer', { message: 'no row' });

    void this.broadcast(whiteboardId, 'timer_changed');

    return toTimerState(row, new Date(row.server_now));
  }

  // ── Private mode ──────────────────────────────────────────────────────────

  async getPrivateMode(
    spaceId: string,
    organizationId: string,
    whiteboardId: string,
  ): Promise<PrivateModeState> {
    const { data, error } = await this.client
      .from('whiteboard_private_sessions')
      .select(
        `id, keep_anonymous, started_at, started_by_user:users!started_by(${WIKI_USER_COLUMNS})`,
      )
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .is('ended_at', null)
      .maybeSingle();

    if (error) throw this.dbError('load private mode', error);
    if (!data) return { active: null };

    const row = data as unknown as {
      id: string;
      keep_anonymous: boolean;
      started_at: string;
      started_by_user: Record<string, unknown> | null;
    };

    return {
      active: {
        id: row.id,
        keep_anonymous: row.keep_anonymous,
        started_at: row.started_at,
        // An anonymous session never says who started it.
        started_by_user: row.keep_anonymous
          ? null
          : withFullName(row.started_by_user),
      },
    };
  }

  /** Starts private mode for everyone. Already on (someone was quicker): returns that session. */
  async startPrivateMode(
    user: RequestUser,
    spaceId: string,
    whiteboardId: string,
    keepAnonymous: boolean,
  ): Promise<PrivateModeState> {
    const { error } = await this.client
      .from('whiteboard_private_sessions')
      .insert({
        whiteboard_id: whiteboardId,
        space_id: spaceId,
        organization_id: user.organizationId,
        keep_anonymous: keepAnonymous,
        started_by: user.userId,
      });

    // 23505: one open session per board, and there already is one: same outcome for the caller.
    if (error && error.code !== '23505') {
      throw this.dbError('start private mode', error);
    }

    if (!error) {
      void this.auditLogs.logActionForRequest(
        user,
        'whiteboard',
        whiteboardId,
        'update',
        { private_mode: 'started', keep_anonymous: keepAnonymous },
      );
      void this.broadcast(whiteboardId, 'private_mode_changed');
    }

    return this.getPrivateMode(spaceId, user.organizationId, whiteboardId);
  }

  /** Ends private mode for everyone. Already off: a no-op. */
  async endPrivateMode(
    user: RequestUser,
    spaceId: string,
    whiteboardId: string,
  ): Promise<PrivateModeState> {
    const { data, error } = await this.client
      .from('whiteboard_private_sessions')
      .update({ ended_at: new Date().toISOString(), ended_by: user.userId })
      .eq('whiteboard_id', whiteboardId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .is('ended_at', null)
      .select('id');

    if (error) throw this.dbError('end private mode', error);

    if ((data ?? []).length > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'whiteboard',
        whiteboardId,
        'update',
        { private_mode: 'ended' },
      );
      void this.broadcast(whiteboardId, 'private_mode_changed');
    }

    return { active: null };
  }

  dbError(
    action: string,
    error: { message: string },
  ): InternalServerErrorException {
    this.logger.error(`Failed to ${action}: ${error.message}`);

    return new InternalServerErrorException(`Failed to ${action}`);
  }
}

/** Row → API state; a running timer past its end reads as `ended`. */
export function toTimerState(row: TimerRow, now: Date): TimerState {
  const ended =
    row.status === 'running' &&
    row.ends_at !== null &&
    new Date(row.ends_at).getTime() <= now.getTime();

  return {
    status: ended ? 'ended' : row.status,
    duration_ms: row.duration_ms,
    ends_at: row.ends_at,
    remaining_ms: row.remaining_ms,
    added_ms: row.added_ms,
    updated_at: row.updated_at,
    server_now: now.toISOString(),
  };
}
