import {
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';

import { testManagementResponseSchema } from './dto/test-management-response.schemas';
import { TestManagementResponseInterceptor } from './test-management-response.interceptor';

const context = {
  switchToHttp: () => ({
    getRequest: () => ({
      method: 'GET',
      url: '/api/v1/spaces/s/test-management/x',
    }),
  }),
} as unknown as ExecutionContext;

const handler = (payload: unknown): CallHandler => ({
  handle: () => of(payload),
});

// One example per reply the routes send, built from the service result types.
const VALID: Record<string, unknown> = {
  idList: 'c1',
  casePage: { items: [], total: 0, page: 1, pageSize: 50 },
  setPage: {
    items: [{ id: 's1', key: 'P-TS1' }],
    total: 1,
    page: 1,
    pageSize: 50,
  },
  historyPage: { items: [{ id: 'h1' }], has_more: false },
  caseDetail: { id: 'c1', key: 'P-TC1', title: 'Login', revision: 2 },
  setDetail: { id: 's1', key: 'P-TS1', name: 'Smoke', member_count: 0 },
  folder: { id: 'f1', parent_id: null, name: 'Root', case_count: 0 },
  settings: {
    assignee_only: true,
    coverable_task_type_ids: [],
    defect_task_type_id: null,
    case_task_type_id: null,
    requirement_link_task_type_ids: [],
  },
  status: { code: 'PASS', applies_to_run: true, applies_to_step: true },
  caseSaved: { changed: true, revision: 3, case: { id: 'c1', key: 'P-TC1' } },
  caseDelete: { deleted: false, has_runs: false, counts: { steps: 2 } },
  bulk: { changed: true, updated: ['c1'], skipped: [] },
  setMembers: {
    changed: true,
    added: ['c1'],
    already_present: [],
    removed: [],
    skipped: [],
  },
  framework: { preset: 'jest', image_key: 'node-24', reason: 'jest.config.js' },
  frameworkUnsupported: { unsupported: 'pytest' },
  frameworkNotFound: { preset: null },
  testCounts: { total: 4, automated: 2 },
  ciJobLog: { text: 'ok', truncated: false, bytes: 2 },
};

describe('testManagementResponseSchema', () => {
  it.each(Object.entries(VALID))('accepts a %s reply', (_name, payload) => {
    expect(testManagementResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('refuses a reply with none of the known identity fields', () => {
    expect(testManagementResponseSchema.safeParse({ foo: 1 }).success).toBe(
      false,
    );
    expect(
      testManagementResponseSchema.safeParse({ id: 1, key: 'P-TC1' }).success,
    ).toBe(false);
  });
});

describe('TestManagementResponseInterceptor', () => {
  const interceptor = new TestManagementResponseInterceptor();
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('hands the same object back and stays quiet for a known shape', async () => {
    const payload = { id: 'c1', key: 'P-TC1', extra: { nested: true } };

    const result = await lastValueFrom(
      interceptor.intercept(context, handler(payload)),
    );

    expect(result).toBe(payload);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks every row of a list and warns once with the count', async () => {
    const payload = ['c1', { foo: 1 }, { bar: 2 }];

    const result = await lastValueFrom(
      interceptor.intercept(context, handler(payload)),
    );

    expect(result).toBe(payload);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String((warn.mock.calls as unknown[][])[0][0]);

    expect(message).toContain('returned 2 of 3 rows');
    expect(message).toContain('GET /api/v1/spaces/s/test-management/x');
  });

  it('passes an unknown shape through unchanged', async () => {
    const payload = { foo: 1 };

    await expect(
      lastValueFrom(interceptor.intercept(context, handler(payload))),
    ).resolves.toBe(payload);
  });

  it('skips empty replies from 204 routes', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(context, handler(undefined))),
    ).resolves.toBe(undefined);
    await expect(
      lastValueFrom(interceptor.intercept(context, handler(null))),
    ).resolves.toBe(null);
    expect(warn).not.toHaveBeenCalled();
  });
});
