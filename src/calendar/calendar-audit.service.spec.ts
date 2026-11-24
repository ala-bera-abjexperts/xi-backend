/**
 * @fileoverview The record of who changed a calendar's sharing.
 *
 * Two properties matter: the row carries the *difference* rather than the whole list, and writing it
 * can never turn a successful save into an error — an audit failure is logged and swallowed.
 */
import { Logger } from '@nestjs/common';
import { CalendarAuditService } from './calendar-audit.service';
import type { CalendarShareDto } from './dto/calendar-share.dto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CalendarAuditService', () => {
  let service: CalendarAuditService;
  let insert: jest.Mock;
  let result: { error: { message: string } | null };

  const ORG = 'org-1';
  const USER = 'user-1';
  const CAL = 'cal-1';

  const share = (overrides: Partial<CalendarShareDto> = {}): CalendarShareDto =>
    ({
      target_type: 'user',
      target_id: 'someone',
      level: 'view',
      ...overrides,
    }) as CalendarShareDto;

  /** The written row, once the fire-and-forget insert has had a turn to run. */
  async function written() {
    await Promise.resolve();
    await Promise.resolve();

    return insert.mock.calls[0]?.[0];
  }

  beforeEach(() => {
    result = { error: null };
    insert = jest.fn().mockReturnValue({
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled),
    });

    const supa = {
      getClient: () => ({ from: () => ({ insert }) }),
    } as unknown as SupabaseAdminService;

    service = new CalendarAuditService(supa);
  });

  describe('when nothing really changed', () => {
    it('writes nothing for two identical lists', async () => {
      service.sharesChanged(ORG, USER, CAL, [share()], [share()]);

      await Promise.resolve();

      expect(insert).not.toHaveBeenCalled();
    });

    it('writes nothing for two empty lists', async () => {
      service.sharesChanged(ORG, USER, CAL, [], []);

      await Promise.resolve();

      expect(insert).not.toHaveBeenCalled();
    });

    it('survives a missing list on either side', async () => {
      expect(() =>
        service.sharesChanged(
          ORG,
          USER,
          CAL,
          undefined as never,
          undefined as never,
        ),
      ).not.toThrow();
      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('the difference it records', () => {
    it('reports a rule that was added', async () => {
      service.sharesChanged(ORG, USER, CAL, [], [share({ target_id: 'new' })]);

      const row = await written();

      expect(row.changes.granted).toEqual([share({ target_id: 'new' })]);
      expect(row.changes.revoked).toEqual([]);
    });

    it('reports a rule that was taken away', async () => {
      service.sharesChanged(ORG, USER, CAL, [share({ target_id: 'old' })], []);

      const row = await written();

      expect(row.changes.revoked).toEqual([share({ target_id: 'old' })]);
      expect(row.changes.granted).toEqual([]);
    });

    it('reports a rule kept at a different level, with both levels', async () => {
      service.sharesChanged(
        ORG,
        USER,
        CAL,
        [share({ level: 'view' })],
        [share({ level: 'manage' })],
      );

      const row = await written();

      expect(row.changes.modified).toEqual([
        { share: share({ level: 'manage' }), from: 'view', to: 'manage' },
      ]);
      expect(row.changes.granted).toEqual([]);
    });

    it('tells two principals apart even at the same level', async () => {
      service.sharesChanged(
        ORG,
        USER,
        CAL,
        [share({ target_id: 'a' })],
        [share({ target_id: 'b' })],
      );

      const row = await written();

      expect(row.changes.granted).toEqual([share({ target_id: 'b' })]);
      expect(row.changes.revoked).toEqual([share({ target_id: 'a' })]);
    });

    it('tells a space role apart from a person with the same name', async () => {
      service.sharesChanged(
        ORG,
        USER,
        CAL,
        [
          share({
            target_type: 'base_role',
            base_role: 'member',
            target_id: undefined,
          }),
        ],
        [share({ target_type: 'user', target_id: 'member' })],
      );

      const row = await written();

      expect(row.changes.granted).toHaveLength(1);
      expect(row.changes.revoked).toHaveLength(1);
    });
  });

  describe('the row it writes', () => {
    it('uses the shape the existing audit screen already renders', async () => {
      service.sharesChanged(ORG, USER, CAL, [], [share()]);

      const row = await written();

      expect(row).toEqual(
        expect.objectContaining({
          organization_id: ORG,
          user_id: USER,
          entity_type: 'calendar_permission',
          entity_id: CAL,
          action: 'permission_change',
        }),
      );
      expect(row.changes.calendar_id).toBe(CAL);
    });
  });

  describe('when the write itself fails', () => {
    it('logs it and never raises, so a saved change is not undone by its record', async () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      result = { error: { message: 'table gone' } };

      expect(() =>
        service.sharesChanged(ORG, USER, CAL, [], [share()]),
      ).not.toThrow();

      await written();

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('table gone'),
      );

      logged.mockRestore();
    });
  });
  describe('every calendar operation is recorded', () => {
    it.each([
      ['calendar', 'create'],
      ['calendar', 'update'],
      ['calendar', 'delete'],
    ] as const)('writes a %s %s row', async (_kind, action) => {
      service.calendar(action, ORG, USER, CAL, { name: 'Team' });

      expect(await written()).toEqual(
        expect.objectContaining({
          organization_id: ORG,
          user_id: USER,
          entity_type: 'calendar',
          entity_id: CAL,
          action,
          changes: { name: 'Team' },
        }),
      );
    });

    it.each(['create', 'update', 'delete'] as const)(
      'writes a calendar_entry %s row',
      async (action) => {
        service.entry(action, ORG, USER, 'entry-1', { summary: 'Standup' });

        expect(await written()).toEqual(
          expect.objectContaining({
            entity_type: 'calendar_entry',
            entity_id: 'entry-1',
            action,
          }),
        );
      },
    );

    it.each([
      'connect',
      'disconnect',
      'reconnect_required',
      'link',
      'unlink',
      'sync',
      'sync_failed',
    ] as const)('writes a calendar_integration %s row', async (action) => {
      service.integration(action, ORG, USER, 'account-1', {
        provider: 'google',
      });

      expect(await written()).toEqual(
        expect.objectContaining({
          entity_type: 'calendar_integration',
          entity_id: 'account-1',
          action,
          changes: { provider: 'google' },
        }),
      );
    });

    it('never raises when the write fails, so the operation itself still succeeds', async () => {
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      result = { error: { message: 'audit table gone' } };

      expect(() =>
        service.integration('sync', ORG, USER, CAL, {}),
      ).not.toThrow();

      await written();

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('audit table gone'),
      );

      logged.mockRestore();
    });
  });
});
