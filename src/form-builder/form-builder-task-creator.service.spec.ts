import { ConflictException } from '@nestjs/common';
import { FormBuilderTaskCreatorService } from './form-builder-task-creator.service';

const assetId = '00000000-0000-0000-0000-000000000003';
const schemaId = '00000000-0000-0000-0000-000000000001';
const typeId = '00000000-0000-0000-0000-000000000002';
const field = (config: Record<string, unknown> = {}, type = 'asset') => ({
  field_key: 'asset',
  field_type: type,
  validation_rules: {
    asset: { schema_id: schemaId, object_type_ids: [typeId], ...config },
  },
});

function setup(
  objects: unknown[] = [{ id: assetId }],
  lookupError: unknown = null,
  integrationExtra: Record<string, unknown> = {},
) {
  let saved: Record<string, unknown> = {};
  let inserted: Record<string, unknown> | undefined;
  const rpc = jest.fn().mockResolvedValue({ data: {}, error: null });
  const queries: Record<string, jest.Mock>[] = [];
  const link = { create: jest.fn().mockResolvedValue({ id: 'link' }) };
  const tasks = { create: jest.fn().mockResolvedValue({ id: 'task' }) };
  const from = jest.fn((table: string) => {
    const q: Record<string, any> = {};
    let update: Record<string, unknown> | undefined;
    for (const method of ['select', 'eq', 'order', 'in', 'overlaps', 'delete'])
      q[method] = jest.fn(() => q);
    q.update = jest.fn((value: Record<string, unknown>) => {
      update = value;
      return q;
    });
    q.insert = jest.fn((value: Record<string, unknown>) => {
      inserted = value;
      return q;
    });
    q.single = jest.fn(() =>
      Promise.resolve({ data: { id: 'request' }, error: null }),
    );
    const resolve = () => {
      if (update) saved = { ...saved, ...update };
      const data =
        table === 'form_builder_submissions'
          ? saved
          : table === 'form_builder'
            ? {
                space_id: 'space',
                created_by: 'user',
                settings: {
                  task_integration: {
                    enabled: true,
                    target_space_id: 'space',
                    link_assets: true,
                    ...integrationExtra,
                  },
                },
              }
            : table === 'form_builder_fields'
              ? [
                  field(),
                  {
                    field_key: 'summary',
                    field_type: 'short_text',
                    validation_rules: { task_field: 'summary' },
                  },
                ]
              : table === 'asset_objects'
                ? objects
                : [{ id: typeId }];
      return { data, error: table === 'asset_objects' ? lookupError : null };
    };
    q.maybeSingle = jest.fn(() => Promise.resolve(resolve()));
    q.then = (fulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolve()).then(fulfilled);
    queries.push(q);
    return q;
  });
  const service = new FormBuilderTaskCreatorService(
    { getClient: () => ({ from, rpc }) } as never,
    tasks as never,
    link as never,
  );
  const run = (
    raw: unknown = assetId,
    config: Record<string, unknown> = {},
    type = 'asset',
    integration = { link_assets: true },
    formSpace = 'space',
  ) =>
    service['linkSubmittedAssets'](
      'form',
      'org',
      'space',
      'user',
      'task',
      { asset: raw },
      [field(config, type)],
      integration,
      formSpace,
    );
  return {
    service,
    run,
    link,
    from,
    queries,
    tasks,
    rpc,
    saved: () => saved,
    inserted: () => inserted,
  };
}

describe('opt-in submission asset links', () => {
  it('scopes every object query and reuses the existing link service', async () => {
    const s = setup();
    expect(await s.run()).toMatchObject({ linked: 1, failed: 0 });
    expect(s.queries[0].eq.mock.calls).toEqual([
      ['organization_id', 'org'],
      ['space_id', 'space'],
      ['schema_id', schemaId],
      ['is_archived', false],
    ]);
    expect(s.queries[0].in.mock.calls).toEqual([
      ['object_type_id', [typeId]],
      ['id', [assetId]],
    ]);
    expect(s.link.create).toHaveBeenCalledWith(
      'space',
      'org',
      'user',
      assetId,
      { task_id: 'task' },
    );
  });
  it('preserves opt-out behavior without querying assets', async () => {
    const s = setup();
    expect(
      await s.run(assetId, {}, 'asset', { link_assets: false }),
    ).toMatchObject({ linked: 0, failed: 0 });
    expect(s.from).not.toHaveBeenCalled();
  });
  it.each([
    ['non-UUID', 'forged', {}, 'asset'],
    ['non-array', assetId, {}, 'asset_multi'],
    ['missing schema', assetId, { schema_id: '' }, 'asset'],
    ['assigned-only', assetId, { assigned_only: true }, 'asset'],
    ['dependent', assetId, { depends_on: 'service' }, 'asset'],
    ['other space', assetId, { space_id: 'other' }, 'asset'],
    ['oversized', Array(201).fill(assetId), {}, 'asset_multi'],
  ])(
    'reports %s selections without linking',
    async (_name, value, config, type) => {
      const s = setup();
      expect(
        (await s.run(value, config as Record<string, unknown>, type)).failed,
      ).toBeGreaterThan(0);
      expect(s.link.create).not.toHaveBeenCalled();
    },
  );
  it('ignores an unanswered optional field even with incomplete configuration', async () => {
    const s = setup();
    expect(await s.run(null, { schema_id: '' })).toMatchObject({ failed: 0 });
    expect(s.from).not.toHaveBeenCalled();
  });
  it('does not substitute the target space for the source form space', async () => {
    const s = setup();
    expect(
      (await s.run(assetId, {}, 'asset', { link_assets: true }, 'other'))
        .failed,
    ).toBe(1);
    expect(s.from).not.toHaveBeenCalled();
  });
  it('rejects an object excluded by the scope query', async () => {
    const s = setup([]);
    expect((await s.run()).failed).toBe(1);
    expect(s.link.create).not.toHaveBeenCalled();
  });
  it('records lookup failures without creating a link', async () => {
    const s = setup([], { message: 'offline' });
    expect((await s.run()).failed).toBe(1);
    expect(s.link.create).not.toHaveBeenCalled();
  });
  it('deduplicates selected IDs', async () => {
    const s = setup();
    await s.run([assetId, assetId], {}, 'asset_multi');
    expect(s.link.create).toHaveBeenCalledTimes(1);
  });
  it('accepts an already-existing association', async () => {
    const s = setup();
    s.link.create.mockRejectedValue(new ConflictException());
    expect((await s.run()).failed).toBe(0);
  });
  it('persists task identity before links and does not recreate on retry', async () => {
    const s = setup();
    s.link.create.mockImplementation(() => {
      expect(s.saved().task_id).toBe('task');
      return Promise.reject(new Error('offline'));
    });
    const submit = () =>
      s.service.maybeCreateTask(
        'form',
        'org',
        'user',
        { summary: 'Synthetic incident', asset: assetId },
        'submission',
      );
    await submit();
    expect(s.saved()).toMatchObject({
      task_id: 'task',
      task_creation_status: 'created',
      task_creation_detail: expect.stringContaining('Asset links:') as unknown,
    });
    await submit();
    expect(s.tasks.create).toHaveBeenCalledTimes(1);
  });
});

describe('customer-portal support request for form-created tasks', () => {
  const portalOn = { create_support_request: true };

  it('opens none when the form has not opted in, even for a logged-in respondent', async () => {
    const s = setup();
    await s.service.maybeCreateTask(
      'form',
      'org',
      'respondent',
      { summary: 'Printer broken' },
      'submission',
    );
    expect(s.tasks.create).toHaveBeenCalledTimes(1);
    expect(s.inserted()).toBeUndefined();
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it('opens a request owned by the logged-in respondent and links it to the task', async () => {
    const s = setup(undefined, null, portalOn);
    await s.service.maybeCreateTask(
      'form',
      'org',
      'respondent',
      { summary: 'Printer broken' },
      'submission',
    );
    expect(s.inserted()).toMatchObject({
      organization_id: 'org',
      created_by: 'respondent',
      space_id: 'space',
      subject: 'Printer broken',
      status: 'open',
      priority: 'medium',
    });
    expect(s.rpc).toHaveBeenCalledWith('sla_link_request_task', {
      p_request_id: 'request',
      p_task_id: 'task',
      p_organization_id: 'org',
    });
  });
  it('opens none for an anonymous submission, whose author is only the form-owner fallback', async () => {
    const s = setup(undefined, null, portalOn);
    await s.service.maybeCreateTask(
      'form',
      'org',
      null,
      { summary: 'Printer broken' },
      'submission',
    );
    expect(s.tasks.create).toHaveBeenCalledTimes(1);
    expect(s.inserted()).toBeUndefined();
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it('keeps the task created when the request cannot be linked', async () => {
    const s = setup(undefined, null, portalOn);
    s.rpc.mockResolvedValue({
      data: null,
      error: { message: 'scope mismatch' },
    });
    s.queries.length = 0;
    await s.service.maybeCreateTask(
      'form',
      'org',
      'respondent',
      { summary: 'Printer broken' },
      'submission',
    );
    expect(s.saved()).toMatchObject({
      task_id: 'task',
      task_creation_status: 'created',
    });
    expect(
      s.queries.some(
        (q) => (q.delete as jest.Mock | undefined)?.mock?.calls.length,
      ),
    ).toBe(true);
  });
});
