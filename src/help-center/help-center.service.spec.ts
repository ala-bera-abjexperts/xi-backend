import { ConflictException, NotFoundException } from '@nestjs/common';
import { HelpCenterService } from './help-center.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

describe('configurable priority on create', () => {
  const request = {
    id: 'request',
    created_by: 'requester',
    organization_id: 'org-1',
    space_id: 'space-1',
    subject: 'Help',
    description: 'Description',
    priority: 'medium',
    custom_field_values: {},
  };
  const baseDto = {
    subject: 'Help',
    description: 'Description',
    category: 'general',
    spaceId: 'space-1',
  } as any;

  const ladder = [
    { id: 'p-lowest', key: 'lowest', space_id: null },
    { id: 'p-high', key: 'high', space_id: null },
    { id: 'p-highest', key: 'highest', space_id: null },
  ];

  function setup() {
    const repo = {
      findSpaceOrganization: jest.fn().mockResolvedValue('org-1'),
      create: jest.fn().mockResolvedValue(request),
      loadPriorityLadder: jest.fn().mockResolvedValue(ladder),
      reserveTask: jest.fn().mockResolvedValue('task-1'),
      linkTask: jest.fn().mockResolvedValue(request),
    };
    const tasks = { create: jest.fn().mockResolvedValue({ id: 'task-1' }) };
    const access = { authorizeSpace: jest.fn().mockResolvedValue(undefined) };

    return {
      repo,
      service: new HelpCenterService(
        repo as any,
        tasks as any,
        {} as any,
        access as any,
        {} as any,
        {} as any,
        {} as any,
      ),
    };
  }

  it('files a ticket under priority_id and derives the legacy bucket', async () => {
    const { service, repo } = setup();

    await service.createSupportRequest('org-1', 'requester', {
      ...baseDto,
      priority_id: 'p-highest',
    });

    expect(repo.create).toHaveBeenCalledWith(
      'org-1',
      'requester',
      expect.objectContaining({ priority_id: 'p-highest', priority: 'critical' }),
    );
  });

  it('buckets a legacy priority when no priority_id is supplied, without reading the ladder', async () => {
    const { service, repo } = setup();

    await service.createSupportRequest('org-1', 'requester', {
      ...baseDto,
      priority: 'high',
    });

    expect(repo.create).toHaveBeenCalledWith(
      'org-1',
      'requester',
      expect.objectContaining({ priority: 'high', priority_id: undefined }),
    );
    expect(repo.loadPriorityLadder).not.toHaveBeenCalled();
  });

  it('rejects an unknown priority_id rather than silently defaulting', async () => {
    const { service, repo } = setup();

    await expect(
      service.createSupportRequest('org-1', 'requester', {
        ...baseDto,
        priority_id: 'not-in-ladder',
      }),
    ).rejects.toThrow('Invalid priority_id');
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('support submission task recovery', () => {
  const request = {
    id: 'request',
    created_by: 'external-requester',
    organization_id: 'owner-org',
    space_id: 'space',
    subject: 'Help',
    description: 'Description',
    priority: 'medium',
    custom_field_values: {},
  };
  const dto = {
    subject: 'Help',
    description: 'Description',
    category: 'general',
    priority: 'medium',
    spaceId: 'space',
  } as any;
  function setup() {
    const repo = {
      findSpaceOrganization: jest.fn().mockResolvedValue('owner-org'),
      create: jest.fn().mockResolvedValue(request),
      reserveTask: jest.fn().mockResolvedValue('reserved-task'),
      linkTask: jest
        .fn()
        .mockResolvedValue({ ...request, task_id: 'reserved-task' }),
      findForStaff: jest.fn().mockResolvedValue(request),
    };
    const tasks = {
      create: jest.fn().mockResolvedValue({ id: 'reserved-task' }),
    };
    const access = { authorizeSpace: jest.fn().mockResolvedValue(undefined) };
    const slaReplies = { requesterReplies: jest.fn() };
    return {
      repo,
      tasks,
      access,
      slaReplies,
      service: new HelpCenterService(
        repo as any,
        tasks as any,
        {} as any,
        access as any,
        slaReplies as any,
        {} as any,
        {} as any,
      ),
    };
  }
  it('keeps a successful request when task creation fails', async () => {
    const { service, tasks, repo } = setup();
    tasks.create.mockRejectedValue(new Error('Unavailable'));
    await expect(
      service.createSupportRequest('requester-org', 'external-requester', dto),
    ).resolves.toEqual(request);
    expect(repo.linkTask).not.toHaveBeenCalled();
  });
  it('uses durable identity and request-owning scope for cross-org requester retry', async () => {
    const { service, tasks, access } = setup();
    await service.retryTask('request', { userId: 'staff' } as any);
    expect(access.authorizeSpace).toHaveBeenCalledWith(
      { userId: 'staff' },
      'owner-org',
      'space',
      'publish_customer_replies',
    );
    expect(tasks.create).toHaveBeenCalledWith(
      'owner-org',
      'external-requester',
      expect.objectContaining({ space_id: 'space' }),
      { supportRequestId: 'request', taskId: 'reserved-task' },
    );
  });
});

describe('HelpCenterService share-aware orchestration', () => {
  const creatorRequest = {
    id: 'req-1',
    created_by: 'creator-1',
    organization_id: 'org-1',
    task_id: 'task-1',
    task: { space_id: 'space-1' },
    requester: { first_name: 'Cara', last_name: 'Creator' },
  };

  function setup(viewerRole: 'creator' | 'shared' = 'creator') {
    const repo = {
      findVisible: jest.fn().mockResolvedValue({
        request: creatorRequest,
        viewer_role: viewerRole,
      }),
      findUserIdByEmail: jest.fn(),
      findShare: jest.fn(),
      insertShare: jest.fn().mockResolvedValue(undefined),
      deleteShare: jest.fn().mockResolvedValue(undefined),
      listShares: jest.fn().mockResolvedValue([]),
      listPortalComments: jest.fn().mockResolvedValue([]),
      listStatusHistory: jest.fn().mockResolvedValue([]),
      listTransitionAudits: jest.fn().mockResolvedValue([]),
      listTaskStatuses: jest.fn().mockResolvedValue([]),
      findUserName: jest.fn().mockResolvedValue({
        id: 'commenter-1',
        first_name: 'Sam',
        last_name: 'Shared',
      }),
    };
    const tasks = {
      createComment: jest.fn().mockResolvedValue({
        id: 'comment-1',
        content: 'hi',
        created_at: '2026-01-02T00:00:00Z',
      }),
    };
    const access = { authorizeSpace: jest.fn() };
    const slaReplies = { requesterReplies: jest.fn().mockResolvedValue([]) };
    const service = new HelpCenterService(
      repo as any,
      tasks as any,
      {} as any,
      access as any,
      slaReplies as any,
      {} as any,
      {} as any,
    );
    return { repo, tasks, access, slaReplies, service };
  }

  // ---- listShares: is_viewer (contract §6 ruling 2026-09-12) --------------

  describe('listShares', () => {
    const shares = [
      { user_id: 'shared-1', user: { first_name: 'Sam', last_name: null } },
      { user_id: 'shared-2', user: null },
    ];

    it('marks only the creator entry as is_viewer when the creator calls', async () => {
      const { repo, service } = setup('creator');
      repo.listShares.mockResolvedValue(shares);

      const rows = await service.listShares('req-1', 'creator-1');

      expect(rows).toEqual([
        {
          user_id: 'creator-1',
          name: 'Cara Creator',
          role: 'creator',
          is_viewer: true,
        },
        { user_id: 'shared-1', name: 'Sam', role: 'shared', is_viewer: false },
        {
          user_id: 'shared-2',
          name: 'Unknown',
          role: 'shared',
          is_viewer: false,
        },
      ]);
    });

    it('marks only the caller own shared entry as is_viewer when a shared user calls', async () => {
      const { repo, service } = setup('shared');
      repo.listShares.mockResolvedValue(shares);

      const rows = await service.listShares('req-1', 'shared-2');

      expect(rows.map((r) => [r.user_id, r.is_viewer])).toEqual([
        ['creator-1', false],
        ['shared-1', false],
        ['shared-2', true],
      ]);
      expect(rows.every((r) => !('email' in r))).toBe(true);
    });
  });

  // ---- Required test 2: share ------------------------------------------

  describe('share', () => {
    it('resolves without error for an unknown email and does not insert', async () => {
      const { repo, service } = setup();
      repo.findUserIdByEmail.mockResolvedValue(null);

      await expect(
        service.share('req-1', 'creator-1', 'nobody@example.com'),
      ).resolves.toBeUndefined();
      expect(repo.insertShare).not.toHaveBeenCalled();
    });

    it('resolves without error and inserts for a known non-creator, non-shared email', async () => {
      const { repo, service } = setup();
      repo.findUserIdByEmail.mockResolvedValue({ id: 'target-1' });
      repo.findShare.mockResolvedValue(null);

      await expect(
        service.share('req-1', 'creator-1', 'Target@Example.com'),
      ).resolves.toBeUndefined();
      expect(repo.findUserIdByEmail).toHaveBeenCalledWith(
        'target@example.com',
        'org-1',
      );
      expect(repo.insertShare).toHaveBeenCalledWith(
        'req-1',
        'target-1',
        'org-1',
        'creator-1',
      );
    });

    it('does not insert when the resolved user is the creator', async () => {
      const { repo, service } = setup();
      repo.findUserIdByEmail.mockResolvedValue({ id: 'creator-1' });

      await service.share('req-1', 'creator-1', 'creator@example.com');
      expect(repo.insertShare).not.toHaveBeenCalled();
    });

    it('does not insert when a share already exists', async () => {
      const { repo, service } = setup();
      repo.findUserIdByEmail.mockResolvedValue({ id: 'target-1' });
      repo.findShare.mockResolvedValue({ user_id: 'target-1' });

      await service.share('req-1', 'creator-1', 'target@example.com');
      expect(repo.insertShare).not.toHaveBeenCalled();
    });
  });

  // ---- Required test 3: unshare -----------------------------------------

  describe('unshare', () => {
    it('lets the creator remove a shared user', async () => {
      const { repo, service } = setup('creator');
      await service.unshare('req-1', 'creator-1', 'shared-1');
      expect(repo.deleteShare).toHaveBeenCalledWith('req-1', 'shared-1');
    });

    it('lets a shared user remove themself', async () => {
      const { repo, service } = setup('shared');
      await service.unshare('req-1', 'shared-1', 'shared-1');
      expect(repo.deleteShare).toHaveBeenCalledWith('req-1', 'shared-1');
    });

    it('404s when a shared user tries to remove someone else', async () => {
      const { repo, service } = setup('shared');
      await expect(
        service.unshare('req-1', 'shared-1', 'other-shared-2'),
      ).rejects.toThrow(NotFoundException);
      expect(repo.deleteShare).not.toHaveBeenCalled();
    });

    it('404s when removing the creator, even as the creator', async () => {
      const { repo, service } = setup('creator');
      await expect(
        service.unshare('req-1', 'creator-1', 'creator-1'),
      ).rejects.toThrow(NotFoundException);
      expect(repo.deleteShare).not.toHaveBeenCalled();
    });
  });

  // ---- Required test 4: addComment --------------------------------------

  describe('addComment', () => {
    it('409s when the request has no linked task', async () => {
      const { repo, service } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...creatorRequest, task_id: null },
        viewer_role: 'creator',
      });

      await expect(
        service.addComment('req-1', 'creator-1', 'hello'),
      ).rejects.toThrow(ConflictException);
    });

    it('creates the comment marked with support_request_id', async () => {
      const { tasks, service } = setup();

      await service.addComment('req-1', 'creator-1', 'hello');

      expect(tasks.createComment).toHaveBeenCalledWith(
        'task-1',
        'org-1',
        'creator-1',
        'hello',
        { support_request_id: 'req-1' },
      );
    });
  });

  // ---- Required test 5: activity ----------------------------------------

  describe('getActivity', () => {
    it('maps status by key, then name, then raw fallback, and sorts ascending', async () => {
      const { repo, slaReplies, service } = setup();
      slaReplies.requesterReplies.mockResolvedValue([
        {
          id: 'reply-1',
          content: 'we are on it',
          published_at: '2026-01-03T00:00:00Z',
        },
      ]);
      repo.listPortalComments.mockResolvedValue([
        {
          id: 'comment-1',
          content: 'thanks',
          created_at: '2026-01-01T00:00:00Z',
          author: { id: 'commenter-1', first_name: 'Sam', last_name: 'Shared' },
        },
      ]);
      repo.listStatusHistory.mockResolvedValue([
        {
          id: 'hist-1',
          changed_at: '2026-01-02T00:00:00Z',
          new_value: 'in_progress',
        },
        {
          id: 'hist-2',
          changed_at: '2026-01-04T00:00:00Z',
          new_value: 'Resolved',
        },
        {
          id: 'hist-3',
          changed_at: '2026-01-05T00:00:00Z',
          new_value: 'totally_custom',
        },
      ]);
      repo.listTaskStatuses.mockResolvedValue([
        { id: 'st-1', key: 'in_progress', name: 'In Progress', color: '#00f' },
        { id: 'st-2', key: 'resolved', name: 'Resolved', color: '#0f0' },
      ]);

      const items = await service.getActivity('req-1', 'creator-1');

      expect(items.map((i) => i.id)).toEqual([
        'comment-1',
        'hist-1',
        'reply-1',
        'hist-2',
        'hist-3',
      ]);
      expect(items[1]).toMatchObject({
        kind: 'status',
        status: { name: 'In Progress', color: '#00f' },
      });
      expect(items[3]).toMatchObject({
        kind: 'status',
        status: { name: 'Resolved', color: '#0f0' },
      });
      expect(items[4]).toMatchObject({
        kind: 'status',
        status: { name: 'totally_custom', color: null },
      });
    });

    it('prefers the transition audit to_status_id when the legacy bucket is ambiguous', async () => {
      const { repo, service } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...creatorRequest, task_id: 'task-1' },
        viewer_role: 'creator',
      });
      // `obsolete` and `done` both collapse to the legacy bucket `done`, so the history row
      // alone cannot tell them apart.
      repo.listStatusHistory.mockResolvedValue([
        {
          id: 'hist-obsolete',
          changed_at: '2026-01-06T10:00:00.000Z',
          new_value: 'done',
        },
      ]);
      repo.listTransitionAudits.mockResolvedValue([
        {
          changed_at: '2026-01-06T10:00:00.100Z',
          to_status_id: 'st-obsolete',
        },
      ]);
      repo.listTaskStatuses.mockResolvedValue([
        { id: 'st-done', key: 'done', name: 'Done', color: '#0f0' },
        {
          id: 'st-obsolete',
          key: 'obsolete',
          name: 'Obsolete',
          color: '#999',
        },
      ]);

      const items = await service.getActivity('req-1', 'creator-1');

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'status',
        status: { name: 'Obsolete', color: '#999' },
      });
    });

    it('falls back to the legacy bucket when two audits are inside the match window', async () => {
      const { repo, service } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...creatorRequest, task_id: 'task-1' },
        viewer_role: 'creator',
      });
      repo.listStatusHistory.mockResolvedValue([
        {
          id: 'hist-done',
          changed_at: '2026-01-07T10:00:00.000Z',
          new_value: 'done',
        },
      ]);
      // Two engine transitions a second apart — neither can be attributed to the row.
      repo.listTransitionAudits.mockResolvedValue([
        { changed_at: '2026-01-07T10:00:00.100Z', to_status_id: 'st-obsolete' },
        { changed_at: '2026-01-07T10:00:01.100Z', to_status_id: 'st-done' },
      ]);
      repo.listTaskStatuses.mockResolvedValue([
        { id: 'st-done', key: 'done', name: 'Done', color: '#0f0' },
        {
          id: 'st-obsolete',
          key: 'obsolete',
          name: 'Obsolete',
          color: '#999',
        },
      ]);

      const items = await service.getActivity('req-1', 'creator-1');

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'status',
        status: { name: 'Done', color: '#0f0' },
      });
    });

    it('skips status history entirely when the request has no linked task', async () => {
      const { repo, service } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...creatorRequest, task_id: null },
        viewer_role: 'creator',
      });

      await service.getActivity('req-1', 'creator-1');

      expect(repo.listStatusHistory).not.toHaveBeenCalled();
    });
  });
});

describe('HelpCenterService customer transitions and form requests', () => {
  const request = {
    id: 'req-1',
    created_by: 'cust-1',
    organization_id: 'org-1',
    task_id: 'task-1',
  };
  const user = {
    userId: 'cust-1',
    organizationId: 'customer-home-org',
    memberships: [],
  } as unknown as RequestUser;
  const ref = { funnelId: 'fun-1', pageId: 'page-1', elementId: 'el-1' };

  const t = (
    id: string,
    over: {
      to?: string | null;
      resolved?: string | null;
      can_execute?: boolean;
      has_screen?: boolean;
    } = {},
  ) => ({
    transition: {
      id,
      name: `T ${id}`,
      to_status_id: over.to === undefined ? 's-ok' : over.to,
    },
    has_screen: over.has_screen ?? false,
    can_execute: over.can_execute ?? true,
    resolved_to_status_id: over.resolved ?? null,
  });

  function setup() {
    const repo = {
      findVisible: jest
        .fn()
        .mockResolvedValue({ request, viewer_role: 'creator' }),
      findPublishedElementContent: jest.fn().mockResolvedValue({
        organizationId: 'org-1',
        content: { allowedStatusIds: ['s-ok', 's-decided'] },
      }),
      findStatusesByIds: jest.fn().mockResolvedValue([
        { id: 's-ok', name: 'Resolved', color: '#0f0' },
        { id: 's-decided', name: 'Closed', color: null },
      ]),
    };
    const engine = {
      getAvailableTransitions: jest.fn().mockResolvedValue({
        workflow_assigned: true,
        transitions: [
          t('ok'),
          t('not-allowed', { to: 's-other' }),
          t('screen', { has_screen: true }),
          t('blocked', { can_execute: false }),
          t('decision', { to: null, resolved: 's-decided' }),
          t('unresolvable', { to: null, resolved: null }),
        ],
      }),
      executeTransition: jest.fn().mockResolvedValue({}),
    };
    const formRequests = {
      listForRequest: jest.fn().mockResolvedValue([]),
      submitForRequest: jest
        .fn()
        .mockResolvedValue({ id: 'fr-1', status: 'completed' }),
    };
    const service = new HelpCenterService(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      engine as any,
      formRequests as any,
    );
    return { repo, engine, formRequests, service };
  }

  describe('listTransitions', () => {
    it('offers only executable, screen-less transitions into an allowed status', async () => {
      const { service, engine, repo } = setup();

      await expect(
        service.listTransitions('req-1', user, ref),
      ).resolves.toEqual([
        {
          id: 'ok',
          name: 'T ok',
          to_status: { id: 's-ok', name: 'Resolved', color: '#0f0' },
        },
        {
          id: 'decision',
          name: 'T decision',
          to_status: { id: 's-decided', name: 'Closed', color: null },
        },
      ]);
      // The engine runs as the request's org, never the caller's home org.
      expect(engine.getAvailableTransitions).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ userId: 'cust-1', organizationId: 'org-1' }),
      );
      expect(repo.findPublishedElementContent).toHaveBeenCalledWith(
        'fun-1',
        'page-1',
        'el-1',
      );
    });

    it('checks visibility before anything else', async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockRejectedValue(
        new NotFoundException('Support request not found'),
      );

      await expect(service.listTransitions('req-1', user, ref)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.findPublishedElementContent).not.toHaveBeenCalled();
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it('404s when the element is missing, of the wrong type, or unpublished', async () => {
      const { service, repo, engine } = setup();
      repo.findPublishedElementContent.mockResolvedValue(null);

      await expect(service.listTransitions('req-1', user, ref)).rejects.toThrow(
        NotFoundException,
      );
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it("404s when the element's funnel belongs to another org", async () => {
      const { service, repo, engine } = setup();
      repo.findPublishedElementContent.mockResolvedValue({
        organizationId: 'org-2',
        content: { allowedStatusIds: ['s-ok'] },
      });

      await expect(service.listTransitions('req-1', user, ref)).rejects.toThrow(
        NotFoundException,
      );
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it('returns [] without calling the engine when allowedStatusIds is empty or absent', async () => {
      const { service, repo, engine } = setup();
      repo.findPublishedElementContent.mockResolvedValue({
        organizationId: 'org-1',
        content: {},
      });

      await expect(
        service.listTransitions('req-1', user, ref),
      ).resolves.toEqual([]);
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it('returns [] when the request has no linked task', async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...request, task_id: null },
        viewer_role: 'creator',
      });

      await expect(
        service.listTransitions('req-1', user, ref),
      ).resolves.toEqual([]);
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it("404s when the element is space-bound to a different space than the request's", async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...request, space_id: 'space-y' },
        viewer_role: 'creator',
      });
      repo.findPublishedElementContent.mockResolvedValue({
        organizationId: 'org-1',
        content: { allowedStatusIds: ['s-ok'], spaceId: 'space-x' },
      });

      await expect(service.listTransitions('req-1', user, ref)).rejects.toThrow(
        NotFoundException,
      );
      expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    });

    it('offers transitions when the element and request share the same space', async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...request, space_id: 'space-x' },
        viewer_role: 'creator',
      });
      repo.findPublishedElementContent.mockResolvedValue({
        organizationId: 'org-1',
        content: {
          allowedStatusIds: ['s-ok', 's-decided'],
          spaceId: 'space-x',
        },
      });

      await expect(
        service.listTransitions('req-1', user, ref),
      ).resolves.not.toEqual([]);
      expect(engine.getAvailableTransitions).toHaveBeenCalled();
    });

    it('offers transitions when the element has no spaceId (backward compatible)', async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...request, space_id: 'space-y' },
        viewer_role: 'creator',
      });
      repo.findPublishedElementContent.mockResolvedValue({
        organizationId: 'org-1',
        content: { allowedStatusIds: ['s-ok', 's-decided'] },
      });

      await expect(
        service.listTransitions('req-1', user, ref),
      ).resolves.not.toEqual([]);
      expect(engine.getAvailableTransitions).toHaveBeenCalled();
    });
  });

  describe('executeTransition', () => {
    it('404s for an un-offered transition and never calls the engine to execute', async () => {
      const { service, engine } = setup();

      for (const transitionId of ['not-allowed', 'screen', 'blocked', 'nope']) {
        await expect(
          service.executeTransition('req-1', user, { ...ref, transitionId }),
        ).rejects.toThrow(NotFoundException);
      }
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('404s when the request has no linked task', async () => {
      const { service, repo, engine } = setup();
      repo.findVisible.mockResolvedValue({
        request: { ...request, task_id: null },
        viewer_role: 'creator',
      });

      await expect(
        service.executeTransition('req-1', user, {
          ...ref,
          transitionId: 'ok',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(engine.executeTransition).not.toHaveBeenCalled();
    });

    it('executes as the request org and returns the refreshed enriched request', async () => {
      const { service, engine, repo } = setup();
      const refreshed = { ...request, task: { status_id: 's-ok' } };
      repo.findVisible
        .mockResolvedValueOnce({ request, viewer_role: 'creator' })
        .mockResolvedValueOnce({ request: refreshed, viewer_role: 'creator' });

      await expect(
        service.executeTransition('req-1', user, {
          ...ref,
          transitionId: 'ok',
          expectedVersion: 3,
        }),
      ).resolves.toEqual({ ...refreshed, viewer_role: 'creator' });
      expect(engine.executeTransition).toHaveBeenCalledWith({
        taskId: 'task-1',
        transitionId: 'ok',
        user: expect.objectContaining({ organizationId: 'org-1' }),
        expectedVersion: 3,
        executionId: expect.any(String),
      });
    });

    it('lets engine errors propagate unchanged', async () => {
      const { service, engine } = setup();
      const err = new ConflictException('Task version mismatch');
      engine.executeTransition.mockRejectedValue(err);

      await expect(
        service.executeTransition('req-1', user, {
          ...ref,
          transitionId: 'ok',
        }),
      ).rejects.toBe(err);
    });
  });

  describe('form requests', () => {
    it('submit 404s on a non-visible request and never reaches the submission', async () => {
      const { service, repo, formRequests } = setup();
      repo.findVisible.mockRejectedValue(
        new NotFoundException('Support request not found'),
      );

      await expect(
        service.submitFormRequest('req-1', 'cust-9', 'fr-1', {}, {}),
      ).rejects.toThrow(NotFoundException);
      expect(formRequests.submitForRequest).not.toHaveBeenCalled();
    });

    it('delegates list and submit with the visible request id and the caller', async () => {
      const { service, formRequests } = setup();
      const meta = { ip: '1.1.1.1', userAgent: 'ua' };

      await service.listFormRequests('req-1', 'cust-1');
      await service.submitFormRequest(
        'req-1',
        'cust-1',
        'fr-1',
        { a: 1 },
        meta,
      );

      expect(formRequests.listForRequest).toHaveBeenCalledWith('req-1');
      expect(formRequests.submitForRequest).toHaveBeenCalledWith(
        'req-1',
        'fr-1',
        'cust-1',
        { a: 1 },
        meta,
      );
    });
  });
});
