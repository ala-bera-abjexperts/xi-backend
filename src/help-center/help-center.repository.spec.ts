/**
 * @fileoverview Unit tests for HelpCenterRepository — the share-aware visibility
 * gate (`findVisible`) and the query-building for the enriched list/activity reads.
 * Uses a fake PostgREST chain double (precedent: `fakeChain` in
 * src/site-studio/public/public-site-studio.service.spec.ts:25-37), extended with
 * `upsert`/`ilike`/`in`/`is`/`gte`/`lte` since this repository also uses them.
 * @module src/help-center/help-center.repository.spec
 * @author Prince Jadiya
 */

import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HelpCenterRepository } from './help-center.repository';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { ListSupportRequestsQueryDto } from './dto/list-support-requests-query.dto';

/** A PostgREST double: every builder method chains, and the chain is awaitable. */
function fakeChain(result: { data: unknown; error?: unknown; count?: number }) {
  const resolved = {
    data: result.data,
    error: result.error ?? null,
    count: result.count,
  };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolved).then(resolve),
    single: jest.fn().mockResolvedValue(resolved),
    maybeSingle: jest.fn().mockResolvedValue(resolved),
  };

  for (const method of [
    'select',
    'eq',
    'in',
    'or',
    'order',
    'limit',
    'range',
    'is',
    'ilike',
    'gte',
    'lte',
    'insert',
    'update',
    'delete',
    'upsert',
  ]) {
    chain[method] = jest.fn(() => chain);
  }

  return chain;
}

function setup() {
  const mockFrom = jest.fn();
  const supabaseAdmin = {
    getClient: () => ({ from: mockFrom }),
  } as unknown as SupabaseAdminService;
  const repo = new HelpCenterRepository(supabaseAdmin);
  return { repo, mockFrom };
}

const baseRequest = {
  id: 'req-1',
  created_by: 'creator-1',
  organization_id: 'org-1',
  task_id: 'task-1',
  task: null,
  requester: null,
  space: null,
};

describe('HelpCenterRepository.findVisible', () => {
  it('returns the request with role creator when the caller is the creator, without querying shares', async () => {
    const { repo, mockFrom } = setup();
    mockFrom.mockReturnValueOnce(fakeChain({ data: baseRequest }));

    const result = await repo.findVisible('req-1', 'creator-1');

    expect(result.viewer_role).toBe('creator');
    expect(result.request).toEqual(baseRequest);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns the request with role shared when a share row exists', async () => {
    const { repo, mockFrom } = setup();
    mockFrom
      .mockReturnValueOnce(fakeChain({ data: baseRequest })) // support_requests
      .mockReturnValueOnce(fakeChain({ data: { user_id: 'shared-1' } })); // support_request_shares

    const result = await repo.findVisible('req-1', 'shared-1');

    expect(result.viewer_role).toBe('shared');
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'support_request_shares');
  });

  it('throws NotFoundException for a stranger (no share row)', async () => {
    const { repo, mockFrom } = setup();
    mockFrom
      .mockReturnValueOnce(fakeChain({ data: baseRequest }))
      .mockReturnValueOnce(fakeChain({ data: null }));

    await expect(repo.findVisible('req-1', 'stranger-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the request does not exist', async () => {
    const { repo, mockFrom } = setup();
    mockFrom.mockReturnValueOnce(fakeChain({ data: null }));

    await expect(repo.findVisible('missing', 'anyone')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('HelpCenterRepository.findByUser', () => {
  it('scope=shared with no shares returns empty without querying support_requests', async () => {
    const { repo, mockFrom } = setup();
    mockFrom.mockReturnValueOnce(fakeChain({ data: [] })); // support_request_shares -> none

    const result = await repo.findByUser('user-1', {
      scope: 'shared',
      page: 1,
      limit: 20,
    } as ListSupportRequestsQueryDto);

    expect(result).toEqual({ data: [], count: 0 });
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('support_request_shares');
  });

  it('sanitizes the search term before building the OR filter', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    mockFrom.mockReturnValueOnce(listChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      search: `foo,.()"'\\%*bar`,
    } as ListSupportRequestsQueryDto);

    expect(listChain.or).toHaveBeenCalledWith('subject.ilike.%foobar%');
  });

  it('adds a ticket_number match when the sanitized search is all digits', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    mockFrom.mockReturnValueOnce(listChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      search: '123',
    } as ListSupportRequestsQueryDto);

    expect(listChain.or).toHaveBeenCalledWith(
      'subject.ilike.%123%,ticket_number.eq.123',
    );
  });

  it('drops the ticket_number clause for a digit string longer than bigint safety (18 digits), without throwing', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    mockFrom.mockReturnValueOnce(listChain);
    const longDigits = '1234567890123456789012345'; // 25 digits

    await expect(
      repo.findByUser('user-1', {
        scope: 'mine',
        page: 1,
        limit: 20,
        search: longDigits,
      } as ListSupportRequestsQueryDto),
    ).resolves.toBeDefined();

    expect(listChain.or).toHaveBeenCalledWith(`subject.ilike.%${longDigits}%`);
  });

  it('ignores an all-punctuation search once sanitized to empty', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    mockFrom.mockReturnValueOnce(listChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      search: `,.()"'\\%*`,
    } as ListSupportRequestsQueryDto);

    expect(listChain.or).not.toHaveBeenCalled();
  });

  it('priorityId matches the id OR the legacy bucket of rows that predate priority_id', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    const priorityChain = fakeChain({
      data: { id: 'p-high', key: 'high', organization_id: 'org-1', space_id: null },
    });

    // Order matters: the list chain is built first, then the priority lookup runs.
    mockFrom.mockReturnValueOnce(listChain).mockReturnValueOnce(priorityChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      priorityId: 'p-high',
    } as ListSupportRequestsQueryDto);

    // `high` is already a legal bucket, so the fast path skips the ladder read.
    expect(mockFrom).toHaveBeenCalledTimes(2);
    expect(listChain.or).toHaveBeenCalledWith(
      'priority_id.eq.p-high,and(priority_id.is.null,priority.eq.high)',
    );
  });

  it('priorityId buckets a CUSTOM key positionally through the ladder', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    const priorityChain = fakeChain({
      data: { id: 'sp-2', key: 'p2', organization_id: 'org-1', space_id: null },
    });
    const ladderChain = fakeChain({
      data: [
        { id: 'sp-1', key: 'p1', space_id: null },
        { id: 'sp-2', key: 'p2', space_id: null },
        { id: 'sp-3', key: 'p3', space_id: null },
        { id: 'sp-4', key: 'p4', space_id: null },
      ],
    });

    mockFrom
      .mockReturnValueOnce(listChain)
      .mockReturnValueOnce(priorityChain)
      .mockReturnValueOnce(ladderChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      priorityId: 'sp-2',
    } as ListSupportRequestsQueryDto);

    // p2 of 4 → the second of four buckets.
    expect(listChain.or).toHaveBeenCalledWith(
      'priority_id.eq.sp-2,and(priority_id.is.null,priority.eq.medium)',
    );
  });

  it('priorityId falls back to an id-only match when the id is unknown', async () => {
    const { repo, mockFrom } = setup();
    const listChain = fakeChain({ data: [], count: 0 });
    const priorityChain = fakeChain({ data: null });

    mockFrom.mockReturnValueOnce(listChain).mockReturnValueOnce(priorityChain);

    await repo.findByUser('user-1', {
      scope: 'mine',
      page: 1,
      limit: 20,
      priorityId: 'ghost',
    } as ListSupportRequestsQueryDto);

    expect(listChain.or).not.toHaveBeenCalled();
    expect(listChain.eq).toHaveBeenCalledWith('priority_id', 'ghost');
  });
});

describe('HelpCenterRepository activity readers', () => {
  it('listPortalComments filters task_comments by support_request_id', async () => {
    const { repo, mockFrom } = setup();
    const chain = fakeChain({ data: [] });
    mockFrom.mockReturnValueOnce(chain);

    await repo.listPortalComments('req-1');

    expect(mockFrom).toHaveBeenCalledWith('task_comments');
    expect(chain.eq).toHaveBeenCalledWith('support_request_id', 'req-1');
  });

  it('listStatusHistory filters task_history to status-change rows only', async () => {
    const { repo, mockFrom } = setup();
    const chain = fakeChain({ data: [] });
    mockFrom.mockReturnValueOnce(chain);

    await repo.listStatusHistory('task-1');

    expect(mockFrom).toHaveBeenCalledWith('task_history');
    expect(chain.eq).toHaveBeenCalledWith('task_id', 'task-1');
    expect(chain.in).toHaveBeenCalledWith('action', [
      'status_change',
      'status_changed',
    ]);
    expect(chain.eq).toHaveBeenCalledWith('field_name', 'status');
  });
});

describe('HelpCenterRepository.findUserIdByEmail', () => {
  it('never reaches ilike when the email contains a wildcard *', async () => {
    const { repo, mockFrom } = setup();

    const result = await repo.findUserIdByEmail('j*@corp.com', 'org-1');

    expect(result).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('treats more than one case-insensitive match as not found, without throwing', async () => {
    const { repo, mockFrom } = setup();
    const chain = fakeChain({ data: [{ id: 'u-1' }, { id: 'u-2' }] });
    mockFrom.mockReturnValueOnce(chain);

    await expect(
      repo.findUserIdByEmail('dup@example.com', 'org-1'),
    ).resolves.toBeNull();
    expect(chain.limit).toHaveBeenCalledWith(2);
    // Not related to any org either — the ambiguity alone is enough to stop here.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('resolves a single match who is a member of the organization', async () => {
    const { repo, mockFrom } = setup();
    const emailChain = fakeChain({ data: [{ id: 'u-1' }] });
    const memberChain = fakeChain({ data: { user_id: 'u-1' } });
    mockFrom.mockReturnValueOnce(emailChain).mockReturnValueOnce(memberChain);

    await expect(
      repo.findUserIdByEmail('single@example.com', 'org-1'),
    ).resolves.toEqual({ id: 'u-1' });
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'organization_members');
    expect(memberChain.eq).toHaveBeenCalledWith('user_id', 'u-1');
    expect(memberChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    // The support-request relation check is short-circuited once membership matches.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('resolves a single match who created a support request in the org but has no membership', async () => {
    const { repo, mockFrom } = setup();
    const emailChain = fakeChain({ data: [{ id: 'u-2' }] });
    const memberChain = fakeChain({ data: null });
    const requesterChain = fakeChain({ data: { id: 'sr-1' } });
    mockFrom
      .mockReturnValueOnce(emailChain)
      .mockReturnValueOnce(memberChain)
      .mockReturnValueOnce(requesterChain);

    await expect(
      repo.findUserIdByEmail('customer@example.com', 'org-1'),
    ).resolves.toEqual({ id: 'u-2' });
    expect(mockFrom).toHaveBeenNthCalledWith(3, 'support_requests');
    expect(requesterChain.eq).toHaveBeenCalledWith('created_by', 'u-2');
    expect(requesterChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
  });

  it('resolves to null for a known email with no relation to the organization (another tenant), without throwing', async () => {
    const { repo, mockFrom } = setup();
    const emailChain = fakeChain({ data: [{ id: 'u-3' }] });
    const memberChain = fakeChain({ data: null });
    const requesterChain = fakeChain({ data: null });
    mockFrom
      .mockReturnValueOnce(emailChain)
      .mockReturnValueOnce(memberChain)
      .mockReturnValueOnce(requesterChain);

    await expect(
      repo.findUserIdByEmail('stranger@other-tenant.com', 'org-1'),
    ).resolves.toBeNull();
  });

  it('escapes a literal backslash before it reaches ilike', async () => {
    const { repo, mockFrom } = setup();
    const chain = fakeChain({ data: [] });
    mockFrom.mockReturnValueOnce(chain);

    await repo.findUserIdByEmail('a\\b@example.com', 'org-1');

    expect(chain.ilike).toHaveBeenCalledWith('email', 'a\\\\b@example.com');
  });
});

describe('HelpCenterRepository.findPublishedElementContent', () => {
  const content = { allowedStatusIds: ['s-1'] };
  const tree = [
    {
      id: 'section-1',
      type: 'section',
      content: [
        { id: 'text-1', type: 'text', content: 'hi' },
        { id: 'el-1', type: 'supportTicketList', content },
      ],
    },
  ];

  it('returns the org and content of a supportTicketList nested anywhere in a published page', async () => {
    const { repo, mockFrom } = setup();
    const page = fakeChain({ data: { content: tree } });
    const funnel = fakeChain({ data: { organization_id: 'org-1' } });
    mockFrom.mockReturnValueOnce(page).mockReturnValueOnce(funnel);

    await expect(
      repo.findPublishedElementContent('funnel-1', 'page-1', 'el-1'),
    ).resolves.toEqual({ organizationId: 'org-1', content });
    expect(page.eq).toHaveBeenCalledWith('id', 'page-1');
    expect(page.eq).toHaveBeenCalledWith('funnel_id', 'funnel-1');
    expect(page.eq).toHaveBeenCalledWith('published', true);
    expect(funnel.eq).toHaveBeenCalledWith('id', 'funnel-1');
    expect(funnel.eq).toHaveBeenCalledWith('published', true);
  });

  it('returns null when the element id matches an element of another type', async () => {
    const { repo, mockFrom } = setup();
    mockFrom
      .mockReturnValueOnce(fakeChain({ data: { content: tree } }))
      .mockReturnValueOnce(fakeChain({ data: { organization_id: 'org-1' } }));

    await expect(
      repo.findPublishedElementContent('funnel-1', 'page-1', 'text-1'),
    ).resolves.toBeNull();
  });

  it('returns null for an unpublished (or missing) page', async () => {
    const { repo, mockFrom } = setup();
    mockFrom
      .mockReturnValueOnce(fakeChain({ data: null }))
      .mockReturnValueOnce(fakeChain({ data: { organization_id: 'org-1' } }));

    await expect(
      repo.findPublishedElementContent('funnel-1', 'page-1', 'el-1'),
    ).resolves.toBeNull();
  });

  it('returns null for an unpublished (or missing) funnel', async () => {
    const { repo, mockFrom } = setup();
    mockFrom
      .mockReturnValueOnce(fakeChain({ data: { content: tree } }))
      .mockReturnValueOnce(fakeChain({ data: null }));

    await expect(
      repo.findPublishedElementContent('funnel-1', 'page-1', 'el-1'),
    ).resolves.toBeNull();
  });
});

describe('HelpCenterRepository.findStatusesByIds', () => {
  it('reads statuses in one org-scoped in() query', async () => {
    const { repo, mockFrom } = setup();
    const chain = fakeChain({
      data: [{ id: 's-1', name: 'Open', color: null }],
    });
    mockFrom.mockReturnValueOnce(chain);

    await expect(repo.findStatusesByIds('org-1', ['s-1'])).resolves.toEqual([
      { id: 's-1', name: 'Open', color: null },
    ]);
    expect(chain.in).toHaveBeenCalledWith('id', ['s-1']);
    expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
  });
});

describe('ListSupportRequestsQueryDto validation', () => {
  it('rejects a sortBy value outside the allow-list', async () => {
    const dto = plainToInstance(ListSupportRequestsQueryDto, {
      sortBy: 'created_by',
    });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'sortBy')).toBe(true);
  });

  it('accepts an allow-listed sortBy value', async () => {
    const dto = plainToInstance(ListSupportRequestsQueryDto, {
      sortBy: 'ticket_number',
    });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'sortBy')).toBe(false);
  });
});
