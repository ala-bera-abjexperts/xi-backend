/**
 * @fileoverview Unit tests for SlaFormRequestsService — staff "request more information"
 * forms (list / create / cancel behind the `publish_customer_replies` task gate) and the
 * customer list/submit path, which reuses Form Builder's task-attached submission and
 * records the customer only on the form-request row.
 * @module src/sla/sla-form-requests.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SlaFormRequestsService } from './sla-form-requests.service';
import { PublicFormBuilderService } from '../form-builder/public/public-form-builder.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

type Result = { data: unknown; error?: unknown };

/** A PostgREST double: every builder method chains, and the chain is awaitable. */
function fakeChain(result: Result) {
  const resolved = { data: result.data, error: result.error ?? null };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolved).then(resolve),
    single: jest.fn().mockResolvedValue(resolved),
    maybeSingle: jest.fn().mockResolvedValue(resolved),
  };
  for (const method of [
    'select',
    'eq',
    'neq',
    'in',
    'order',
    'insert',
    'update',
  ]) {
    chain[method] = jest.fn(() => chain);
  }
  return chain as Record<string, jest.Mock>;
}

const TABLE = 'support_request_form_requests';

// toPublicField reads no instance state, so a prototype-only instance runs the real sanitizer.
const realSanitizer = Object.create(
  PublicFormBuilderService.prototype,
) as PublicFormBuilderService;
const task = { id: 'task-1', organization_id: 'org-1', space_id: 'space-1' };
const user = { userId: 'staff-1', organizationId: 'org-1' } as RequestUser;
const publishedForm = {
  id: 'form-1',
  status: 'published',
  space_id: 'space-1',
  organization_id: 'org-1',
  is_deleted: false,
};
const fieldRow = (field_type: string, extra: Record<string, unknown> = {}) => ({
  id: `f-${field_type}`,
  field_key: `k_${field_type}`,
  field_type,
  label: field_type,
  placeholder: null,
  help_text: null,
  required: true,
  options: null,
  validation_rules: null,
  page_index: 0,
  section: null,
  column_span: null,
  sort_order: 0,
  conditional_logic: null,
  calculation: null,
  default_value: null,
  ...extra,
});

function setup(tables: Record<string, Result[]> = {}) {
  const queues: Record<string, Array<Record<string, jest.Mock>>> = {};
  for (const [table, results] of Object.entries(tables)) {
    queues[table] = results.map(fakeChain);
  }
  const chains: Record<string, Array<Record<string, jest.Mock>>> = {};
  const from = jest.fn((table: string) => {
    const chain = queues[table]?.shift();
    if (!chain) throw new Error(`unexpected from(${table})`);
    (chains[table] ??= []).push(chain);
    return chain;
  });
  const access = { authorizeTask: jest.fn().mockResolvedValue(task) };
  const submissions = { create: jest.fn().mockResolvedValue({ id: 'sub-1' }) };
  const publicForms = {
    loadFields: jest.fn().mockResolvedValue([fieldRow('short_text')]),
    resolveAssetOptions: jest.fn().mockResolvedValue(new Map()),
    // The REAL public-form sanitizer, so the emitted field shape is asserted — not a mock's.
    toPublicField: (
      ...args: Parameters<PublicFormBuilderService['toPublicField']>
    ) => realSanitizer.toPublicField(...args),
  };
  const service = new SlaFormRequestsService(
    { getClient: () => ({ from }) } as any,
    access as any,
    submissions as any,
    publicForms as any,
  );
  return { service, from, chains, access, submissions, publicForms };
}

describe('SlaFormRequestsService — staff', () => {
  it('authorizes with publish_customer_replies before touching any table', async () => {
    const { service, access, from } = setup();
    access.authorizeTask.mockRejectedValue(new ForbiddenException());

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).rejects.toThrow(ForbiddenException);
    expect(access.authorizeTask).toHaveBeenCalledWith(
      user,
      'task-1',
      'publish_customer_replies',
    );
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects a task without a linked support request', async () => {
    const { service, from } = setup({ support_requests: [{ data: null }] });

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).rejects.toThrow('Link a support request first');
    expect(from).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unpublished', { status: 'draft' }],
    ['other-space', { space_id: 'space-2' }],
    ['other-org', { organization_id: 'org-2' }],
    ['deleted', { is_deleted: true }],
  ])('rejects a %s form and inserts nothing', async (_label, override) => {
    const { service, chains } = setup({
      support_requests: [{ data: { id: 'req-1' } }],
      form_builder: [{ data: { ...publishedForm, ...override } }],
    });

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).rejects.toThrow(BadRequestException);
    expect(chains[TABLE]).toBeUndefined();
  });

  it('rejects a form with a publicly unsafe field type, naming it', async () => {
    const { service, chains } = setup({
      support_requests: [{ data: { id: 'req-1' } }],
      form_builder: [{ data: publishedForm }],
      form_builder_fields: [
        { data: [fieldRow('short_text'), fieldRow('not_a_real_type')] },
      ],
    });

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).rejects.toThrow(/not_a_real_type/);
    expect(chains[TABLE]).toBeUndefined();
  });

  it('accepts a repeater field — publishable by the 2026-09-10 owner decision', async () => {
    const created = { id: 'fr-1', status: 'pending' };
    const { service, chains } = setup({
      support_requests: [{ data: { id: 'req-1' } }],
      form_builder: [{ data: publishedForm }],
      form_builder_fields: [
        { data: [fieldRow('short_text'), fieldRow('repeater')] },
      ],
      [TABLE]: [{ data: created }],
    });

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).resolves.toEqual(created);
    expect(chains[TABLE]?.[0]?.insert).toHaveBeenCalled();
  });

  it('rejects upload fields, including one nested in a layout cell', async () => {
    const { service, chains } = setup({
      support_requests: [{ data: { id: 'req-1' } }],
      form_builder: [{ data: publishedForm }],
      form_builder_fields: [
        {
          data: [
            fieldRow('file_upload'),
            fieldRow('layout', {
              options: { rows: 1, columns: 1, cells: [[{ type: 'audio' }]] },
            }),
          ],
        },
      ],
    });

    const err = await service
      .createForTask(user, 'task-1', 'form-1')
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/audio/);
    expect((err as Error).message).toMatch(/file_upload/);
    expect(chains[TABLE]).toBeUndefined();
  });

  it('inserts the row scoped to the task org, linked request and requesting staff user', async () => {
    const created = { id: 'fr-1', status: 'pending' };
    const { service, chains } = setup({
      support_requests: [{ data: { id: 'req-1' } }],
      form_builder: [{ data: publishedForm }],
      form_builder_fields: [{ data: [fieldRow('short_text')] }],
      [TABLE]: [{ data: created }],
    });

    await expect(
      service.createForTask(user, 'task-1', 'form-1'),
    ).resolves.toEqual(created);
    expect(chains[TABLE][0].insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      request_id: 'req-1',
      task_id: 'task-1',
      form_id: 'form-1',
      requested_by: 'staff-1',
    });
    expect(chains.support_requests[0].eq).toHaveBeenCalledWith(
      'organization_id',
      'org-1',
    );
  });

  it('cancels only from pending, guarded by a conditional update', async () => {
    const { service, chains } = setup({
      [TABLE]: [
        { data: { id: 'fr-1', status: 'pending' } },
        { data: [{ id: 'fr-1' }] },
      ],
    });

    await service.cancel(user, 'task-1', 'fr-1');

    const update = chains[TABLE][1];
    expect(update.update).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(update.eq).toHaveBeenCalledWith('status', 'pending');
  });

  it.each(['completed', 'cancelled'])(
    'refuses to cancel a %s request with 409',
    async (status) => {
      const { service, chains } = setup({
        [TABLE]: [{ data: { id: 'fr-1', status } }],
      });

      await expect(service.cancel(user, 'task-1', 'fr-1')).rejects.toThrow(
        ConflictException,
      );
      expect(chains[TABLE]).toHaveLength(1);
    },
  );

  it('404s when cancelling a request that is not on this task', async () => {
    const { service } = setup({ [TABLE]: [{ data: null }] });
    await expect(service.cancel(user, 'task-1', 'fr-x')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SlaFormRequestsService — customer', () => {
  const pendingRow = {
    id: 'fr-1',
    status: 'pending',
    task_id: 'task-1',
    organization_id: 'org-1',
    form: { id: 'form-1', space_id: 'space-1', organization_id: 'org-1' },
  };
  const meta = { ip: '1.2.3.4', userAgent: 'jest' };

  it('404s for a form request that does not belong to the request', async () => {
    const { service, chains, submissions } = setup({
      [TABLE]: [{ data: null }],
    });

    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
    ).rejects.toThrow(NotFoundException);
    expect(chains[TABLE][0].eq).toHaveBeenCalledWith('request_id', 'req-1');
    expect(submissions.create).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled'])(
    '409s when the form request is %s',
    async (status) => {
      const { service, submissions } = setup({
        [TABLE]: [{ data: { ...pendingRow, status } }],
      });

      await expect(
        service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
      ).rejects.toThrow(ConflictException);
      expect(submissions.create).not.toHaveBeenCalled();
    },
  );

  it('refuses a form that gained an upload field after it was requested', async () => {
    const { service, submissions, publicForms } = setup({
      [TABLE]: [{ data: pendingRow }],
    });
    publicForms.loadFields.mockResolvedValue([fieldRow('file_upload')]);

    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
    ).rejects.toThrow(BadRequestException);
    expect(submissions.create).not.toHaveBeenCalled();
  });

  /**
   * A one-row `support_request_form_requests` double whose reads and conditional updates are
   * evaluated against live state at await time — so concurrent claims really race.
   */
  function formRequestTable() {
    const state: Record<string, unknown> = {
      ...pendingRow,
      request_id: 'req-1',
      submission_id: null,
      submitted_by: null,
      completed_at: null,
    };
    const from = () => {
      let patch: Record<string, unknown> | null = null;
      const where: Record<string, unknown> = {};
      const run = () => {
        const matches = Object.entries(where).every(([k, v]) => state[k] === v);
        if (patch && matches) Object.assign(state, patch);
        const data = patch
          ? matches
            ? [{ id: state.id }]
            : []
          : matches
            ? { ...state }
            : null;
        return Promise.resolve({ data, error: null });
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (k: string, v: unknown) => {
          where[k] = v;
          return chain;
        },
        is: (k: string, v: unknown) => {
          where[k] = v;
          return chain;
        },
        maybeSingle: run,
        then: (resolve: (value: unknown) => unknown) => run().then(resolve),
      };
      return chain as Record<string, jest.Mock>;
    };
    return { state, from };
  }

  it('claims first, submits through Form Builder with task_id and NO submitter, then sets submission_id', async () => {
    const { service, from, submissions } = setup();
    const table = formRequestTable();
    from.mockImplementation(table.from);
    let statusDuringCreate: unknown;
    submissions.create.mockImplementation(() => {
      statusDuringCreate = table.state.status;
      return Promise.resolve({ id: 'sub-1' });
    });
    const data = { k_short_text: 'answer' };

    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', data, meta),
    ).resolves.toEqual({ id: 'fr-1', status: 'completed' });

    expect(statusDuringCreate).toBe('completed');
    expect(submissions.create).toHaveBeenCalledWith(
      'form-1',
      { data, task_id: 'task-1' },
      'space-1',
      'org-1',
      null,
      meta,
    );
    expect(table.state).toMatchObject({
      status: 'completed',
      submitted_by: 'cust-1',
      submission_id: 'sub-1',
    });
    expect(typeof table.state.completed_at).toBe('string');
  });

  it('lets exactly one of two concurrent submits create a submission; the other gets 409', async () => {
    const { service, from, submissions } = setup();
    const table = formRequestTable();
    from.mockImplementation(table.from);

    const results = await Promise.allSettled([
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
      service.submitForRequest('req-1', 'fr-1', 'cust-2', {}, meta),
    ]);

    expect(submissions.create).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
  });

  it('reverts the claim to pending and rethrows the original error when create fails', async () => {
    const { service, from, submissions } = setup();
    const table = formRequestTable();
    from.mockImplementation(table.from);
    const original = new BadRequestException('Answer is required');
    submissions.create.mockRejectedValue(original);

    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
    ).rejects.toBe(original);

    expect(table.state).toMatchObject({
      status: 'pending',
      submitted_by: null,
      completed_at: null,
      submission_id: null,
    });
  });

  it('keeps the claim completed (no revert, no second create) when the submission_id link update fails after create succeeds', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service, from, submissions } = setup();
    const table = formRequestTable();
    let callCount = 0;
    from.mockImplementation(() => {
      callCount++;
      const chain = table.from();
      if (callCount === 3) {
        // The submission_id link update — simulate it failing AFTER create() already resolved.
        (chain as unknown as Record<string, unknown>).then = (
          resolve: (value: unknown) => unknown,
        ) =>
          Promise.resolve({
            data: null,
            error: { message: 'link update failed' },
          }).then(resolve);
      }
      return chain;
    });

    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
    ).resolves.toEqual({ id: 'fr-1', status: 'completed' });

    expect(submissions.create).toHaveBeenCalledTimes(1);
    // The claim stays completed — no revert to pending.
    expect(table.state).toMatchObject({
      status: 'completed',
      submitted_by: 'cust-1',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to link submission'),
    );

    // A retry against the now-completed row gets 409, never a second create.
    await expect(
      service.submitForRequest('req-1', 'fr-1', 'cust-1', {}, meta),
    ).rejects.toThrow(ConflictException);
    expect(submissions.create).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('lists non-cancelled rows with sanitized public fields for pending only', async () => {
    const { service, chains, publicForms } = setup({
      [TABLE]: [
        {
          data: [
            {
              id: 'fr-1',
              status: 'pending',
              created_at: 'c1',
              completed_at: null,
              form: {
                id: 'form-1',
                name: 'More info',
                description: null,
                space_id: 'space-1',
                organization_id: 'org-1',
              },
            },
            {
              id: 'fr-2',
              status: 'completed',
              created_at: 'c2',
              completed_at: 'd2',
              form: {
                id: 'form-2',
                name: 'Done',
                description: 'x',
                space_id: 'space-1',
                organization_id: 'org-1',
              },
            },
          ],
        },
      ],
    });

    const rows = await service.listForRequest('req-1');

    expect(chains[TABLE][0].neq).toHaveBeenCalledWith('status', 'cancelled');
    expect(publicForms.loadFields).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({
      id: 'fr-1',
      status: 'pending',
      form: { id: 'form-1', name: 'More info', description: null },
    });
    const field = rows[0].form.fields[0] as Record<string, unknown>;
    expect(field).toMatchObject({ field_key: 'k_short_text', required: true });
    expect(field).not.toHaveProperty('is_required');
    expect(field).not.toHaveProperty('id');
    expect(rows[0].form).not.toHaveProperty('space_id');
    expect(rows[1].form.fields).toEqual([]);
  });
});
