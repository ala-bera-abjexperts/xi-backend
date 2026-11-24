/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test doubles are typed as `any`; the type-checked unsafe rules add no value in mock assertions */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { FormBuilderWebhooksService } from './form-builder-webhooks.service';
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { encryptApiKey } from '../lib/crypto/encryption';
import type { CreateWebhookDto } from './dto/create-webhook.dto';
import type { UpdateWebhookDto } from './dto/update-webhook.dto';

jest.mock('../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/crypto/encryption', () => ({
  encryptApiKey: jest.fn(() => ({ encrypted: 'enc', iv: 'iv', tag: 'tag' })),
  decryptApiKey: jest.fn(() => 'plain-secret'),
}));

const assertUrl = assertPublicHttpUrl as jest.Mock;
const encrypt = encryptApiKey as unknown as jest.Mock;

// A chainable + thenable Supabase query-builder stub. Terminal `single`/`maybeSingle`
// resolve to `resolved`; every other builder returns the same chain (so `.eq().eq()...`
// keeps chaining) and the chain itself is awaitable via `then`.
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.upsert = jest.fn().mockImplementation(self);
  chain.delete = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.neq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.contains = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected);

  return chain;
}

describe('FormBuilderWebhooksService', () => {
  let service: FormBuilderWebhooksService;
  let mockFrom: jest.Mock;
  let dispatcher: { sendTest: jest.Mock };
  const ctx = { spaceId: 'space-1', orgId: 'org-1' };

  function queueTables(
    tableQueues: Record<string, ReturnType<typeof buildChain>[]>,
  ) {
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    dispatcher = { sendTest: jest.fn() };

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderWebhooksService(
      supabase,
      dispatcher as unknown as FormBuilderWebhookDispatcherService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates a webhook: encrypts the secret, inserts scoped columns, and returns a secret-free view', async () => {
    const createdRow = {
      id: 'wh-1',
      form_id: 'form-1',
      provider: 'generic',
      url: 'https://hooks.example.com/x',
      events: ['submission.created'],
      is_active: true,
      secret_encrypted: 'enc',
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const formChain = buildChain({ data: { id: 'form-1' }, error: null });
    const webhookChain = buildChain({ data: createdRow, error: null });

    queueTables({
      form_builder: [formChain],
      form_builder_webhooks: [webhookChain],
    });

    const dto = {
      url: 'https://hooks.example.com/x',
      secret: 'topsecret',
    } as CreateWebhookDto;

    const result = await service.create('form-1', dto, ctx, 'user-1');

    expect(result).toEqual({
      id: 'wh-1',
      form_id: 'form-1',
      provider: 'generic',
      url: 'https://hooks.example.com/x',
      events: ['submission.created'],
      is_active: true,
      hasSecret: true,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    // never leaks the secret material to the client view.
    expect(result).not.toHaveProperty('secret');
    expect(result).not.toHaveProperty('secret_encrypted');

    expect(assertUrl).toHaveBeenCalledWith('https://hooks.example.com/x');
    expect(encrypt).toHaveBeenCalledWith('topsecret');
    expect(webhookChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        space_id: 'space-1',
        form_id: 'form-1',
        provider: 'generic',
        url: 'https://hooks.example.com/x',
        events: ['submission.created'],
        is_active: true,
        created_by: 'user-1',
        secret_encrypted: 'enc',
        secret_iv: 'iv',
        secret_tag: 'tag',
      }),
    );
  });

  it('creates a webhook without a secret and omits the secret columns', async () => {
    const createdRow = {
      id: 'wh-2',
      form_id: 'form-1',
      provider: 'slack',
      url: 'https://hooks.slack.com/x',
      events: ['submission.created'],
      is_active: true,
      secret_encrypted: null,
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const formChain = buildChain({ data: { id: 'form-1' }, error: null });
    const webhookChain = buildChain({ data: createdRow, error: null });

    queueTables({
      form_builder: [formChain],
      form_builder_webhooks: [webhookChain],
    });

    const dto = {
      url: 'https://hooks.slack.com/x',
      provider: 'slack',
    } as CreateWebhookDto;

    const result = await service.create('form-1', dto, ctx, 'user-1');

    expect(result.hasSecret).toBe(false);
    expect(encrypt).not.toHaveBeenCalled();

    const insertArg = webhookChain.insert.mock.calls[0][0];

    expect(insertArg).not.toHaveProperty('secret_encrypted');
  });

  it('rejects an unsafe webhook URL with BadRequestException', async () => {
    const formChain = buildChain({ data: { id: 'form-1' }, error: null });

    queueTables({ form_builder: [formChain] });

    assertUrl.mockRejectedValueOnce(new Error('Webhook URL must use HTTPS'));

    const dto = { url: 'http://internal.local' } as CreateWebhookDto;

    await expect(service.create('form-1', dto, ctx, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFoundException when the parent form does not exist', async () => {
    const formChain = buildChain({ data: null, error: null });

    queueTables({ form_builder: [formChain] });

    const dto = { url: 'https://hooks.example.com/x' } as CreateWebhookDto;

    await expect(service.create('missing', dto, ctx, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lists webhooks as secret-free views', async () => {
    const rows = [
      {
        id: 'wh-1',
        form_id: 'form-1',
        provider: 'generic',
        url: 'https://a.example.com',
        events: ['submission.created'],
        is_active: true,
        secret_encrypted: 'enc',
        created_by: 'user-1',
        created_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      {
        id: 'wh-2',
        form_id: 'form-1',
        provider: 'slack',
        url: 'https://b.example.com',
        events: ['submission.created'],
        is_active: false,
        secret_encrypted: null,
        created_by: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
    const formChain = buildChain({ data: { id: 'form-1' }, error: null });
    const listChain = buildChain({ data: rows, error: null });

    queueTables({
      form_builder: [formChain],
      form_builder_webhooks: [listChain],
    });

    const result = await service.list('form-1', ctx);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'wh-1', hasSecret: true });
    expect(result[1]).toMatchObject({ id: 'wh-2', hasSecret: false });
    expect(listChain.eq).toHaveBeenCalledWith('form_id', 'form-1');
  });

  it('updates a webhook and re-encrypts a provided secret', async () => {
    const existing = {
      id: 'wh-1',
      provider: 'generic',
      url: 'https://old.example.com',
      is_active: true,
      secret_encrypted: null,
      secret_iv: null,
      secret_tag: null,
    };
    const updatedRow = {
      id: 'wh-1',
      form_id: 'form-1',
      provider: 'generic',
      url: 'https://new.example.com',
      events: ['submission.created'],
      is_active: false,
      secret_encrypted: 'enc',
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-03T00:00:00Z',
    };
    const getChain = buildChain({ data: existing, error: null });
    const updateChain = buildChain({ data: updatedRow, error: null });

    queueTables({ form_builder_webhooks: [getChain, updateChain] });

    const dto = {
      url: 'https://new.example.com',
      isActive: false,
      secret: 'rotated',
    } as UpdateWebhookDto;

    const result = await service.update('form-1', 'wh-1', dto, ctx);

    expect(result).toMatchObject({
      id: 'wh-1',
      url: 'https://new.example.com',
      is_active: false,
      hasSecret: true,
    });
    expect(assertUrl).toHaveBeenCalledWith('https://new.example.com');
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://new.example.com',
        is_active: false,
        secret_encrypted: 'enc',
        secret_iv: 'iv',
        secret_tag: 'tag',
      }),
    );
  });

  it('removes a webhook and returns success', async () => {
    const removeChain = buildChain({ data: { id: 'wh-1' }, error: null });

    queueTables({ form_builder_webhooks: [removeChain] });

    await expect(service.remove('form-1', 'wh-1', ctx)).resolves.toEqual({
      success: true,
    });
  });

  it('throws NotFoundException when removing a webhook that does not exist', async () => {
    const removeChain = buildChain({ data: null, error: null });

    queueTables({ form_builder_webhooks: [removeChain] });

    await expect(service.remove('form-1', 'missing', ctx)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('delegates sendTest to the dispatcher and shapes the result', async () => {
    const webhookRow = {
      id: 'wh-1',
      provider: 'generic',
      url: 'https://hooks.example.com/x',
      is_active: true,
      secret_encrypted: null,
      secret_iv: null,
      secret_tag: null,
    };
    const getChain = buildChain({ data: webhookRow, error: null });

    queueTables({ form_builder_webhooks: [getChain] });

    dispatcher.sendTest.mockResolvedValue({ ok: true, status: 200 });

    const result = await service.sendTest('form-1', 'wh-1', ctx);

    expect(dispatcher.sendTest).toHaveBeenCalledWith(webhookRow);
    expect(result).toEqual({ ok: true, statusCode: 200, error: null });
  });

  it('surfaces a dispatcher failure through sendTest', async () => {
    const webhookRow = {
      id: 'wh-1',
      provider: 'generic',
      url: 'https://hooks.example.com/x',
      is_active: true,
      secret_encrypted: null,
      secret_iv: null,
      secret_tag: null,
    };
    const getChain = buildChain({ data: webhookRow, error: null });

    queueTables({ form_builder_webhooks: [getChain] });

    dispatcher.sendTest.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'boom',
    });

    const result = await service.sendTest('form-1', 'wh-1', ctx);

    expect(result).toEqual({ ok: false, statusCode: 500, error: 'boom' });
  });
});
