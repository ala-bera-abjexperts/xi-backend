/**
 * @fileoverview WhiteboardLiveService — the board guard, the live channel token, broadcasts,
 * the timer and private mode. The SQL state machines themselves are verified against the
 * database (Step 2); here: what the service sends, maps and hides.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WhiteboardLiveService, toTimerState } from './whiteboard-live.service';

const SPACE = 'space-1';
const BOARD = 'board-1';
const SIGNING_KEY = 'test-secret-at-least-32-characters-long!!';
const user = {
  userId: 'u-1',
  authUserId: 'auth-1',
  organizationId: 'org-1',
} as RequestUser;

/** Thenable query chain resolving to `result`; records its calls. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
  const self = () => c;

  for (const m of [
    'select',
    'eq',
    'is',
    'insert',
    'update',
    'order',
    'limit',
    'in',
  ]) {
    c[m] = jest.fn(self);
  }
  c.maybeSingle = jest.fn(() => Promise.resolve(result));
  c.single = jest.fn(() => Promise.resolve(result));
  (c as unknown as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve);

  return c;
}

describe('WhiteboardLiveService', () => {
  let tables: Record<string, ReturnType<typeof chain>[]>;
  let rpc: jest.Mock;
  let boards: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let config: Record<string, string | undefined>;
  let fetchMock: jest.Mock;
  let service: WhiteboardLiveService;

  const queue = (table: string, data: unknown, error: unknown = null) => {
    const c = chain({ data, error });

    (tables[table] ??= []).push(c);

    return c;
  };

  beforeEach(() => {
    tables = {};
    rpc = jest.fn();
    boards = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      assertBoardAccess: jest.fn().mockResolvedValue(undefined),
    };
    audit = { logActionForRequest: jest.fn().mockResolvedValue(undefined) };
    config = {
      'supabase.jwtSecret': SIGNING_KEY,
      SUPABASE_URL: 'http://supabase.local/',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    };
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = {
      from: jest.fn((table: string) => {
        const next = tables[table]?.shift();

        if (!next) throw new Error(`unexpected query on ${table}`);

        return next;
      }),
      rpc,
    };

    service = new WhiteboardLiveService(
      { getClient: () => client } as never,
      boards as never,
      audit as never,
      {
        get: (key: string, fallback?: string) => config[key] ?? fallback,
      } as never,
      new JwtService({}),
    );
  });

  describe('resolveBoard', () => {
    it('checks the module and the Share level, then the board in the caller org', async () => {
      const q = queue('whiteboards', { is_archived: false });

      await service.resolveBoard(user, SPACE, BOARD, 'can_edit', true);

      expect(boards.assertAvailable).toHaveBeenCalledWith('org-1', SPACE);
      expect(boards.assertBoardAccess).toHaveBeenCalledWith(
        SPACE,
        'u-1',
        BOARD,
        'can_edit',
      );
      expect(q.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('404s for a board that is not there', async () => {
      queue('whiteboards', null);

      await expect(
        service.resolveBoard(user, SPACE, BOARD, 'can_view', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses writes on an archived board but allows reads', async () => {
      queue('whiteboards', { is_archived: true });
      await expect(
        service.resolveBoard(user, SPACE, BOARD, 'can_view', true),
      ).rejects.toBeInstanceOf(ConflictException);

      queue('whiteboards', { is_archived: true });
      await expect(
        service.resolveBoard(user, SPACE, BOARD, 'can_view', false),
      ).resolves.toBeUndefined();
    });

    it('passes a Share denial through', async () => {
      boards.assertBoardAccess.mockRejectedValue(new ForbiddenException());

      await expect(
        service.resolveBoard(user, SPACE, BOARD, 'can_view', false),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('mintToken', () => {
    it('grants exactly this board topic under its own claim, for 10 minutes', async () => {
      const res = await service.mintToken(user, BOARD, false);
      const claims = new JwtService({}).verify<Record<string, unknown>>(
        res.token,
        { secret: SIGNING_KEY },
      );

      expect(res.topic).toBe(`whiteboard:${BOARD}`);
      expect(claims.whiteboard_topics).toEqual([`whiteboard:${BOARD}`]);
      expect(claims.wiki_topics).toBeUndefined();
      expect(claims.sub).toBe('auth-1');
      expect(claims.role).toBe('authenticated');
      expect((claims.exp as number) - (claims.iat as number)).toBe(600);
      expect(Date.parse(res.server_now)).not.toBeNaN();
    });

    it.each([true, false])(
      'scene topic: readable by all, writable only by editors (edit=%s)',
      async (canEdit) => {
        const res = await service.mintToken(user, BOARD, canEdit);
        const claims = new JwtService({}).verify<Record<string, unknown>>(
          res.token,
          { secret: SIGNING_KEY },
        );
        const scene = `whiteboard:${BOARD}:scene`;

        expect(res.scene_topic).toBe(scene);
        expect(res.can_edit_scene).toBe(canEdit);
        expect(claims.whiteboard_scene_topics).toEqual([scene]);
        expect(claims.whiteboard_edit_topics).toEqual(canEdit ? [scene] : []);
        expect(claims.whiteboard_topics).toEqual([`whiteboard:${BOARD}`]);
      },
    );

    it('is unavailable without the JWT secret', async () => {
      config['supabase.jwtSecret'] = undefined;

      await expect(service.mintToken(user, BOARD, true)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('broadcast', () => {
    it('sends a private event on the board topic with the service key', async () => {
      await service.broadcast(BOARD, 'timer_changed');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        messages: Record<string, unknown>[];
      };

      expect(url).toBe('http://supabase.local/realtime/v1/api/broadcast');
      expect(body.messages[0]).toMatchObject({
        topic: `whiteboard:${BOARD}`,
        event: 'timer_changed',
        private: true,
      });
    });

    it('merges the payload after the timestamp', async () => {
      await service.broadcast(BOARD, 'scene_changed', { revision: 7 });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        messages: { payload: Record<string, unknown> }[];
      };

      const { at, ...rest } = body.messages[0].payload;

      expect(Date.parse(at as string)).not.toBeNaN();
      expect(rest).toEqual({ revision: 7 });
    });

    it('never throws (a lost event only means a later refetch)', async () => {
      fetchMock.mockRejectedValue(new Error('offline'));

      await expect(
        service.broadcast(BOARD, 'timer_changed'),
      ).resolves.toBeUndefined();
    });
  });

  describe('timer', () => {
    it('reads an unused board as idle with a 30 minute default', async () => {
      queue('whiteboard_timers', null);

      const t = await service.getTimer(SPACE, 'org-1', BOARD);

      expect(t).toMatchObject({
        status: 'idle',
        duration_ms: 1800000,
        added_ms: 0,
      });
    });

    it('sends the typed time with set and with resume', async () => {
      rpc.mockResolvedValue({
        data: [
          {
            status: 'idle',
            duration_ms: 90000,
            ends_at: null,
            remaining_ms: null,
            added_ms: 0,
            updated_at: '2026-10-09T10:00:00Z',
            server_now: '2026-10-09T10:00:00Z',
          },
        ],
        error: null,
      });

      await service.commandTimer(user, SPACE, BOARD, 'set', 90000);
      expect(rpc).toHaveBeenLastCalledWith(
        'whiteboard_timer_command',
        expect.objectContaining({ p_action: 'set', p_duration_ms: 90000 }),
      );

      await service.commandTimer(user, SPACE, BOARD, 'resume', 120000);
      expect(rpc).toHaveBeenLastCalledWith(
        'whiteboard_timer_command',
        expect.objectContaining({ p_action: 'resume', p_duration_ms: 120000 }),
      );

      await service.commandTimer(user, SPACE, BOARD, 'resume');
      expect(rpc).toHaveBeenLastCalledWith(
        'whiteboard_timer_command',
        expect.objectContaining({ p_action: 'resume', p_duration_ms: null }),
      );
    });

    it('never sends a duration with pause, then broadcasts', async () => {
      rpc.mockResolvedValue({
        data: [
          {
            status: 'paused',
            duration_ms: 60000,
            ends_at: null,
            remaining_ms: 30000,
            updated_at: '2026-10-06T10:00:00Z',
            server_now: '2026-10-06T10:00:00Z',
          },
        ],
        error: null,
      });

      const t = await service.commandTimer(user, SPACE, BOARD, 'pause', 99999);

      expect(rpc).toHaveBeenCalledWith(
        'whiteboard_timer_command',
        expect.objectContaining({ p_action: 'pause', p_duration_ms: null }),
      );
      expect(t).toMatchObject({ status: 'paused', remaining_ms: 30000 });
      expect(fetchMock).toHaveBeenCalled();
    });

    it('maps bad input to 400 and a missing board to 404', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'duration' },
      });
      await expect(
        service.commandTimer(user, SPACE, BOARD, 'start', 1),
      ).rejects.toBeInstanceOf(BadRequestException);

      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23503', message: 'fk' },
      });
      await expect(
        service.commandTimer(user, SPACE, BOARD, 'start', 60000),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reads a running timer past its end as ended', () => {
      const t = toTimerState(
        {
          status: 'running',
          duration_ms: 60000,
          ends_at: '2026-10-06T10:00:00Z',
          remaining_ms: null,
          added_ms: 60000,
          updated_at: null,
        },
        new Date('2026-10-06T10:00:01Z'),
      );

      expect(t.status).toBe('ended');
      expect(t.added_ms).toBe(60000);
      expect(t.server_now).toBe('2026-10-06T10:00:01.000Z');
    });
  });

  describe('private mode', () => {
    it('never reveals who started an anonymous session', async () => {
      queue('whiteboard_private_sessions', {
        id: 'ps-1',
        keep_anonymous: true,
        started_at: '2026-10-06T10:00:00Z',
        started_by_user: { id: 'u-1', first_name: 'Ada' },
      });

      const s = await service.getPrivateMode(SPACE, 'org-1', BOARD);

      expect(s.active).toMatchObject({ id: 'ps-1', started_by_user: null });
    });

    it('names the starter of a non-anonymous session', async () => {
      queue('whiteboard_private_sessions', {
        id: 'ps-1',
        keep_anonymous: false,
        started_at: '2026-10-06T10:00:00Z',
        started_by_user: { id: 'u-1', first_name: 'Ada', last_name: 'L' },
      });

      const s = await service.getPrivateMode(SPACE, 'org-1', BOARD);

      expect(s.active?.started_by_user).toMatchObject({ full_name: 'Ada L' });
    });

    it('start when it is already on: returns the running session, no second audit or event', async () => {
      queue('whiteboard_private_sessions', null, {
        code: '23505',
        message: 'dup',
      });
      queue('whiteboard_private_sessions', {
        id: 'ps-1',
        keep_anonymous: false,
        started_at: '2026-10-06T10:00:00Z',
        started_by_user: null,
      });

      const s = await service.startPrivateMode(user, SPACE, BOARD, true);

      expect(s.active?.id).toBe('ps-1');
      expect(audit.logActionForRequest).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('start audits and broadcasts', async () => {
      queue('whiteboard_private_sessions', null);
      queue('whiteboard_private_sessions', null);

      await service.startPrivateMode(user, SPACE, BOARD, true);

      expect(audit.logActionForRequest).toHaveBeenCalledWith(
        user,
        'whiteboard',
        BOARD,
        'update',
        { private_mode: 'started', keep_anonymous: true },
      );
      expect(fetchMock).toHaveBeenCalled();
    });

    it('ending when it is already off is a quiet no-op', async () => {
      queue('whiteboard_private_sessions', []);

      await expect(service.endPrivateMode(user, SPACE, BOARD)).resolves.toEqual(
        { active: null },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
