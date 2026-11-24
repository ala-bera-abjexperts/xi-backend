/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test doubles are typed as `any`; the type-checked unsafe rules add no value in mock assertions */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { MailService } from '../mail/mail.service';
import type { AssignFormDto } from './dto/assign-form.dto';

const TABLE = 'form_builder_assignments';
const FORMS_TABLE = 'form_builder';

type Resolved = Record<string, unknown>;
type Chain = Record<string, jest.Mock | ((...a: unknown[]) => unknown)>;

describe('FormBuilderAssignmentsService', () => {
  let service: FormBuilderAssignmentsService;
  let mockFrom: jest.Mock;
  let broadcast: { broadcastNotification: jest.Mock };
  let mail: { sendNotificationEmail: jest.Mock };

  const SPACE = 'space-1';
  const ORG = 'org-1';
  const ACTOR = 'actor-1';

  function buildChain(resolved: Resolved): Chain {
    const chain: Chain = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.lte = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  function useQueues(queues: Record<string, Chain[]>) {
    mockFrom.mockImplementation((table: string) => {
      const q = queues[table];

      if (!q || !q.length) throw new Error(`unexpected from(${table})`);

      return q.shift() as Chain;
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    broadcast = {
      broadcastNotification: jest.fn().mockResolvedValue(undefined),
    };
    mail = { sendNotificationEmail: jest.fn().mockResolvedValue(undefined) };

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderAssignmentsService(
      supabase,
      broadcast as unknown as NotificationsBroadcastService,
      mail as unknown as MailService,
    );
  });

  // ── assign ─────────────────────────────────────────────────────────────────

  describe('assign', () => {
    it('upserts assignee rows, notifies fresh assignees, and returns counts', async () => {
      const upsertChain = buildChain({
        data: [{ id: 'a1', assignee_user_id: 'u1' }],
        error: null,
      });

      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
          buildChain({ data: { name: 'Survey' }, error: null }),
        ],
        [TABLE]: [upsertChain],
        spaces: [buildChain({ data: { key: 'space-key' }, error: null })],
        users: [
          buildChain({
            data: { first_name: 'Ann', last_name: 'Lee' },
            error: null,
          }),
          buildChain({
            data: [{ id: 'u1', email: 'u1@test.dev' }],
            error: null,
          }),
        ],
        notifications: [buildChain({ data: [{ id: 'n1' }], error: null })],
        space_members: [buildChain({ data: [], error: null })],
      });

      const dto = { userIds: ['u1', 'u2'] } as AssignFormDto;
      const result = await service.assign('form-1', dto, SPACE, ORG, ACTOR);

      expect(result).toEqual({
        assignedCount: 1,
        alreadyAssignedCount: 1,
        cannotSubmitCount: 0,
      });

      expect(upsertChain.upsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            organization_id: ORG,
            space_id: SPACE,
            form_id: 'form-1',
            assignee_user_id: 'u1',
            assigned_by: ACTOR,
          }),
        ]),
        expect.objectContaining({
          onConflict: 'form_id,assignee_user_id',
          ignoreDuplicates: true,
        }),
      );

      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(mail.sendNotificationEmail).toHaveBeenCalledWith(
        'u1@test.dev',
        expect.stringContaining('Survey'),
        expect.stringContaining('Survey'),
      );
    });

    it('expands roles to their active space members before upserting', async () => {
      const resolveChain = buildChain({
        data: [
          {
            member_type: 'user',
            user_id: 'u3',
            group_id: null,
            role_id: null,
            space_role: 'member',
          },
        ],
        error: null,
      });
      const upsertChain = buildChain({
        data: [{ id: 'a3', assignee_user_id: 'u3' }],
        error: null,
      });

      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
          buildChain({ data: { name: 'Survey' }, error: null }),
        ],
        space_members: [resolveChain, buildChain({ data: [], error: null })],
        [TABLE]: [upsertChain],
        spaces: [buildChain({ data: { key: 'space-key' }, error: null })],
        users: [
          buildChain({
            data: { first_name: 'Ann', last_name: 'Lee' },
            error: null,
          }),
          buildChain({
            data: [{ id: 'u3', email: 'u3@test.dev' }],
            error: null,
          }),
        ],
        notifications: [buildChain({ data: [{ id: 'n1' }], error: null })],
      });

      const dto = { roles: ['member'] } as AssignFormDto;
      const result = await service.assign('form-1', dto, SPACE, ORG, ACTOR);

      expect(resolveChain.in).toHaveBeenCalledWith('space_role', ['member']);
      expect(result.assignedCount).toBe(1);
      expect(result.alreadyAssignedCount).toBe(0);
    });

    it('counts viewers without a submit override as unable to submit', async () => {
      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
          buildChain({ data: { name: 'Survey' }, error: null }),
        ],
        [TABLE]: [
          buildChain({
            data: [{ id: 'a1', assignee_user_id: 'u1' }],
            error: null,
          }),
        ],
        spaces: [buildChain({ data: { key: 'space-key' }, error: null })],
        users: [
          buildChain({
            data: { first_name: 'Ann', last_name: 'Lee' },
            error: null,
          }),
          buildChain({
            data: [{ id: 'u1', email: 'u1@test.dev' }],
            error: null,
          }),
        ],
        notifications: [buildChain({ data: [{ id: 'n1' }], error: null })],
        space_members: [
          buildChain({
            data: [{ user_id: 'u1', space_role: 'viewer', permissions: null }],
            error: null,
          }),
        ],
      });

      const dto = { userIds: ['u1'] } as AssignFormDto;
      const result = await service.assign('form-1', dto, SPACE, ORG, ACTOR);

      expect(result.cannotSubmitCount).toBe(1);
    });

    it('throws NotFound when the form is missing or lives elsewhere', async () => {
      useQueues({
        [FORMS_TABLE]: [buildChain({ data: null, error: null })],
      });

      const dto = { userIds: ['u1'] } as AssignFormDto;

      await expect(
        service.assign('nope', dto, SPACE, ORG, ACTOR),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when no assignees resolve from users/roles', async () => {
      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
        ],
      });

      const dto = {} as AssignFormDto;

      await expect(
        service.assign('form-1', dto, SPACE, ORG, ACTOR),
      ).rejects.toThrow(/No assignees resolved/);
    });

    it('throws BadRequest when the upsert fails', async () => {
      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
        ],
        [TABLE]: [buildChain({ data: null, error: { message: 'conflict' } })],
      });

      const dto = { userIds: ['u1'] } as AssignFormDto;

      await expect(
        service.assign('form-1', dto, SPACE, ORG, ACTOR),
      ).rejects.toThrow(/conflict/);
    });
  });

  // ── listForForm ──────────────────────────────────────────────────────────

  describe('listForForm', () => {
    it('returns assignment rows scoped to the form/space/org', async () => {
      const listChain = buildChain({
        data: [{ id: 'a1', assignee_user_id: 'u1' }],
        error: null,
      });

      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
        ],
        [TABLE]: [listChain],
      });

      const result = await service.listForForm('form-1', SPACE, ORG);

      expect(result).toEqual([{ id: 'a1', assignee_user_id: 'u1' }]);
      expect(listChain.eq).toHaveBeenCalledWith('form_id', 'form-1');
    });

    it('throws BadRequest when the assignment query fails', async () => {
      useQueues({
        [FORMS_TABLE]: [
          buildChain({ data: { id: 'form-1', name: 'Survey' }, error: null }),
        ],
        [TABLE]: [buildChain({ data: null, error: { message: 'boom' } })],
      });

      await expect(service.listForForm('form-1', SPACE, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── listMine ───────────────────────────────────────────────────────────────

  describe('listMine', () => {
    it('drops assignments whose form was soft-deleted', async () => {
      useQueues({
        [TABLE]: [
          buildChain({
            data: [
              { id: 'a1', form: { id: 'f1', is_deleted: false } },
              { id: 'a2', form: { id: 'f2', is_deleted: true } },
              { id: 'a3', form: null },
            ],
            error: null,
          }),
        ],
      });

      const result = await service.listMine(SPACE, ORG, 'u1');

      expect(result.map((r) => r.id)).toEqual(['a1', 'a3']);
    });

    it('throws BadRequest when the query fails', async () => {
      useQueues({
        [TABLE]: [buildChain({ data: null, error: { message: 'boom' } })],
      });

      await expect(service.listMine(SPACE, ORG, 'u1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── markCompletedOnSubmit ────────────────────────────────────────────────

  describe('markCompletedOnSubmit', () => {
    it('flips the submitter pending row to completed', async () => {
      const updateChain = buildChain({ error: null });

      useQueues({ [TABLE]: [updateChain] });

      await expect(
        service.markCompletedOnSubmit('form-1', 'u1', 'sub-1', SPACE, ORG),
      ).resolves.toBeUndefined();

      expect(updateChain.update).toHaveBeenCalledWith({
        status: 'completed',
        completed_submission_id: 'sub-1',
      });
      expect(updateChain.eq).toHaveBeenCalledWith('status', 'pending');
    });

    it('is a no-op for anonymous submitters (no user id)', async () => {
      await expect(
        service.markCompletedOnSubmit('form-1', null, 'sub-1', SPACE, ORG),
      ).resolves.toBeUndefined();

      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('swallows update errors without throwing', async () => {
      useQueues({
        [TABLE]: [buildChain({ error: { message: 'db down' } })],
      });

      await expect(
        service.markCompletedOnSubmit('form-1', 'u1', 'sub-1', SPACE, ORG),
      ).resolves.toBeUndefined();
    });
  });
});
