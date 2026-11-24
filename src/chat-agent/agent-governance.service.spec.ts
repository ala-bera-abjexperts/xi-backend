import { SpaceMemberRulesService } from '../spaces/space-member-rules.service';
import { ConflictException } from '@nestjs/common';

import { AgentGovernanceError, AgentGovernanceService, type AgentMemberChange } from './agent-governance.service';
import { freeSpaceKey, permOf, rankOf, spaceKeyBase, tableOf } from './pipeline/agent-kinds';

const ORG = 'org-1';
const SPACE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ME = 'me';
const THEM = 'them';
const actor = { userId: ME, organizationId: ORG };

type Row = Record<string, unknown>;

/** Just enough of the query builder: equality filters over rows held per table. */
function fakeClient(tables: Record<string, Row[]>, rpc = jest.fn()) {
  return {
    rpc,
    from(table: string) {
      const filters: [string, unknown][] = [];
      const inFilters: [string, unknown[]][] = [];
      const rows = () =>
        (tables[table] ?? []).filter(
          (r) =>
            filters.every(([k, v]) => (r[k] ?? null) === v) &&
            inFilters.every(([k, v]) => k === 'status' || v.includes(r[k])),
        );
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
        is: (k: string, v: unknown) => (filters.push([k, v]), chain),
        not: () => chain,
        in: (k: string, v: unknown[]) => (inFilters.push([k, v]), chain),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (done: (r: { data: Row[]; error: null }) => unknown) => done({ data: rows(), error: null }),
      };
      return chain;
    },
  };
}

interface World {
  myOrgRole?: string;
  myRole?: string | null;
  theirOrgRole?: string;
  theirRole?: string | null;
  theirActive?: boolean;
  held?: string[];
  canCreate?: boolean;
  archived?: boolean;
  rpc?: jest.Mock;
  actions?: Row[];
}

function build(world: World = {}) {
  const members: Row[] = [];
  if (world.myRole)
    members.push({ space_id: SPACE, member_type: 'user', user_id: ME, space_role: world.myRole, is_active: true });
  if (world.theirRole)
    members.push({
      space_id: SPACE,
      member_type: 'user',
      user_id: THEM,
      space_role: world.theirRole,
      is_active: world.theirActive ?? true,
    });
  const client = fakeClient(
    {
      spaces: [{ id: SPACE, organization_id: ORG, is_archived: world.archived ?? false, deleting_at: null }],
      organization_members: [
        { organization_id: ORG, user_id: ME, role: world.myOrgRole ?? 'member' },
        { organization_id: ORG, user_id: THEM, role: world.theirOrgRole ?? 'member', users: { is_active: true } },
      ],
      space_members: members,
      agent_actions: world.actions ?? [],
    },
    world.rpc ?? jest.fn().mockResolvedValue({ data: { ok: true }, error: null }),
  );
  const held = new Set(world.held ?? ['manage_members']);
  const permissions = {
    checkPermission: jest.fn().mockResolvedValue(world.canCreate ?? true),
    orgGrantsSpacePermission: jest.fn().mockResolvedValue(false),
    hasSpacePermission: jest.fn(async (_u: string, _o: string, _s: string, key: string) => held.has(key)),
    isAdminOrOwner: jest.fn().mockResolvedValue(false),
    getUserSpacePermissions: jest.fn().mockResolvedValue({ isMember: true, permissions: { create_processes: held.has('create_processes') } }),
    bustOrg: jest.fn(),
  };
  const spaces = {
    createSpace: jest.fn().mockResolvedValue({ id: SPACE }),
    addSpaceMember: jest.fn().mockResolvedValue({}),
    updateSpaceModules: jest.fn().mockResolvedValue([]),
  };
  const processes = { create: jest.fn().mockResolvedValue({ id: 'p' }) };
  const runs = { cancelActions: jest.fn().mockResolvedValue(1) };
  const audit = { logAction: jest.fn() };
  const service = new AgentGovernanceService(
    { getClient: () => client } as never,
    permissions as never,
    spaces as never,
    processes as never,
    runs as never,
    audit as never,
    new SpaceMemberRulesService({ getClient: () => client } as never, permissions as never),
  );
  return { service, permissions, spaces, processes, runs, audit, client };
}

const change = (over: Partial<AgentMemberChange> = {}): AgentMemberChange => ({
  kind: 'space_member_role',
  spaceId: SPACE,
  userId: THEM,
  role: 'member',
  ...over,
});

const codeOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentGovernanceError);
    return (err as AgentGovernanceError).code;
  }
};

describe('AgentGovernanceService', () => {
  describe('the commander never gives more than they have', () => {
    it('refuses without manage_members, whatever the role asked for', async () => {
      const { service } = build({ held: [], myRole: 'viewer', theirRole: 'viewer' });
      expect(await service.memberProblem(actor, change())).toBe('no_manage_permission');
    });

    it('refuses a role above their own', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'member' });
      expect(await service.memberProblem(actor, change({ role: 'owner' }))).toBe('role_above_yours');
    });

    it('lets them grant their own rank', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'member' });
      expect(await service.memberProblem(actor, change({ role: 'admin' }))).toBeNull();
    });

    it('refuses to touch someone above them, by space role', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'owner' });
      expect(await service.memberProblem(actor, change({ kind: 'space_member_remove', role: null }))).toBe('target_above_you');
    });

    it('refuses to touch an org admin, whatever their space role says', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'viewer', theirOrgRole: 'admin' });
      expect(await service.memberProblem(actor, change({ kind: 'space_member_remove', role: null }))).toBe('target_above_you');
    });

    it('counts an org admin as owner: they may grant owner and act on owners', async () => {
      const { service } = build({ myOrgRole: 'admin', myRole: null, theirRole: 'owner' });
      expect(await service.memberProblem(actor, change({ role: 'owner' }))).toBeNull();
    });

    it('refuses a permission they do not hold', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'member', held: ['manage_members', 'create_tasks'] });
      const flags = change({ kind: 'space_member_permissions', role: null, grant: ['delete_space'] });
      expect(await service.memberProblem(actor, flags)).toBe('permission_not_yours');
    });

    it('refuses a key that is no space permission', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'member' });
      const flags = change({ kind: 'space_member_permissions', role: null, grant: ['is_superuser'] });
      expect(await service.memberProblem(actor, flags)).toBe('unknown_permission');
    });

    it('takes the can_ prefix as the same key', async () => {
      const { service } = build({ myRole: 'admin', theirRole: 'member', held: ['manage_members', 'create_tasks'] });
      const flags = change({ kind: 'space_member_permissions', role: null, revoke: ['can_create_tasks'] });
      expect(await service.memberProblem(actor, flags)).toBeNull();
    });

    it('refuses an archived space and one of another organization', async () => {
      expect(await build({ archived: true, myRole: 'owner' }).service.memberProblem(actor, change())).toBe('space_unavailable');
      expect(
        await build({ myRole: 'owner' }).service.memberProblem(actor, change({ spaceId: 'other-org-space' })),
      ).toBe('space_unavailable');
    });

    it('does not write when the check fails', async () => {
      const rpc = jest.fn();
      const { service } = build({ held: [], rpc });
      expect(await codeOf(service.changeMember(actor, change()))).toBe('no_manage_permission');
      expect(rpc).not.toHaveBeenCalled();
    });

    it('says on the card when this is the last owner', async () => {
      const { service } = build({ myOrgRole: 'owner', theirRole: 'owner' });
      expect(await service.memberProblem(actor, change({ kind: 'space_member_remove', role: null }))).toBe('last_owner');
      expect(await service.memberProblem(actor, change({ role: 'member' }))).toBe('last_owner');
    });

    it('lets one of two owners go', async () => {
      const { service } = build({ myRole: 'owner', theirRole: 'owner' });
      expect(await service.memberProblem(actor, change({ kind: 'space_member_remove', role: null }))).toBeNull();
    });

    it('asks again at the write: losing the permission after the card stops it', async () => {
      const { service, permissions, spaces } = build({ myRole: 'admin' });
      expect(await service.memberProblem(actor, change({ kind: 'space_member_add' }))).toBeNull();
      permissions.hasSpacePermission.mockResolvedValue(false);
      expect(await codeOf(service.changeMember(actor, change({ kind: 'space_member_add' })))).toBe('no_manage_permission');
      expect(spaces.addSpaceMember).not.toHaveBeenCalled();
    });
  });

  describe('members', () => {
    it('adds through the normal service, as a member by default', async () => {
      const { service, spaces, permissions } = build({ myRole: 'owner' });
      expect(await service.changeMember(actor, change({ kind: 'space_member_add', role: null }))).toEqual({ adopted: false });
      expect(spaces.addSpaceMember).toHaveBeenCalledWith(SPACE, ORG, ME, {
        member_type: 'user',
        user_id: THEM,
        space_role: 'member',
      });
      expect(permissions.bustOrg).toHaveBeenCalledWith(ORG);
    });

    it('adopts an add a crash left behind, with no second row', async () => {
      const { service, spaces } = build({ myRole: 'owner', theirRole: 'member' });
      expect(await service.changeMember(actor, change({ kind: 'space_member_add' }))).toEqual({ adopted: true });
      expect(spaces.addSpaceMember).not.toHaveBeenCalled();
    });

    it('says so when someone is a member already, in another role', async () => {
      const { service } = build({ myRole: 'owner', theirRole: 'admin' });
      expect(await codeOf(service.changeMember(actor, change({ kind: 'space_member_add' })))).toBe('already_member');
    });

    it('refuses someone who left the organization or was deactivated', async () => {
      const left = build({ myRole: 'owner' });
      const ghost = change({ kind: 'space_member_add', userId: 'ghost', role: null });
      expect(await codeOf(left.service.changeMember(actor, ghost))).toBe('not_in_organization');
      expect(left.spaces.addSpaceMember).not.toHaveBeenCalled();
    });

    it('needs someone to be a member before changing them', async () => {
      const { service } = build({ myRole: 'owner' });
      expect(await service.memberProblem(actor, change())).toBe('not_member');
    });

    it('passes on the last-owner refusal of the locked write', async () => {
      const rpc = jest.fn().mockResolvedValue({ data: { ok: false, code: 'last_owner' }, error: null });
      const { service, audit } = build({ myRole: 'owner', theirRole: 'owner', rpc });
      const remove = change({ kind: 'space_member_remove', role: null });
      expect(await codeOf(service.changeMember(actor, remove))).toBe('last_owner');
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('audits a change and cancels what a removed person had open', async () => {
      const { service, audit, runs } = build({
        myRole: 'owner',
        theirRole: 'member',
        actions: [{ id: 'open-1', organization_id: ORG, target_space_id: SPACE, 'agent_runs.invoker_id': THEM }],
      });
      await service.changeMember(actor, change({ kind: 'space_member_remove', role: null }));
      expect(audit.logAction).toHaveBeenCalled();
      expect(runs.cancelActions).toHaveBeenCalledWith(ORG, 'requester_no_access', { actionIds: ['open-1'] });
    });

    it('leaves the proposals of an org admin, who keeps the space anyway', async () => {
      const { service, runs, permissions } = build({ myOrgRole: 'owner', theirRole: 'member' });
      permissions.isAdminOrOwner.mockResolvedValue(true);
      await service.changeMember(actor, change({ kind: 'space_member_remove', role: null }));
      expect(runs.cancelActions).not.toHaveBeenCalled();
    });

    it('counts a retried remove as done and cancels nothing again', async () => {
      const rpc = jest.fn().mockResolvedValue({ data: { ok: true, noop: true }, error: null });
      const { service, runs, audit } = build({ myRole: 'owner', rpc });
      expect(await service.changeMember(actor, change({ kind: 'space_member_remove', role: null }))).toEqual({ adopted: true });
      expect(runs.cancelActions).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });
  });

  describe('spaces', () => {
    const plan = { name: 'Audit 2027', key: 'AUDIT', description: null, enableWiki: false };

    it('refuses without can_create_spaces, and writes nothing', async () => {
      const { service, spaces } = build({ canCreate: false });
      expect(await codeOf(service.createSpace(actor, 'new-id', plan))).toBe('no_create_space');
      expect(spaces.createSpace).not.toHaveBeenCalled();
    });

    it('creates under the reserved id and clears the permission cache for what follows', async () => {
      const { service, spaces, permissions } = build();
      await service.createSpace(actor, 'new-id', plan);
      expect(spaces.createSpace.mock.calls[0][3]).toEqual({ id: 'new-id' });
      expect(permissions.bustOrg).toHaveBeenCalledWith(ORG);
      expect(spaces.updateSpaceModules).not.toHaveBeenCalled();
    });

    it('switches the wiki on only when a page of the request needs it', async () => {
      const { service, spaces } = build();
      await service.createSpace(actor, 'new-id', { ...plan, enableWiki: true });
      expect(spaces.updateSpaceModules).toHaveBeenCalledWith('new-id', ME, ORG, [{ module_type: 'wiki', is_enabled: true }]);
    });

    it('keeps the space when only switching the wiki on failed', async () => {
      const { service, spaces } = build();
      spaces.updateSpaceModules.mockRejectedValue(new Error('nope'));
      await expect(service.createSpace(actor, 'new-id', { ...plan, enableWiki: true })).resolves.toEqual({ adopted: false });
    });

    it('adopts the space a retried Confirm finds under its id', async () => {
      const { service, spaces } = build();
      expect(await service.createSpace(actor, SPACE, plan)).toEqual({ adopted: true });
      expect(spaces.createSpace).not.toHaveBeenCalled();
    });

    it('validates what the route pipe would have: a bad key never reaches the service', async () => {
      const { service, spaces } = build();
      expect(await codeOf(service.createSpace(actor, 'new-id', { ...plan, key: 'bad key!' }))).toBe('invalid_input');
      expect(spaces.createSpace).not.toHaveBeenCalled();
    });

    it('names a taken name or key', async () => {
      const { service, spaces } = build();
      spaces.createSpace.mockRejectedValue(new ConflictException('taken'));
      expect(await codeOf(service.createSpace(actor, 'new-id', plan))).toBe('name_taken');
    });
  });

  describe('processes', () => {
    const plan = { title: 'Patch management', description: null, requestType: 'Prozessbewertung', assigneeId: null, scores: {} };

    it('refuses without create_processes', async () => {
      const { service, processes } = build({ held: [] });
      expect(await codeOf(service.createProcess(actor, 'p1', SPACE, plan))).toBe('no_create_process');
      expect(processes.create).not.toHaveBeenCalled();
    });

    it('refuses a space of another organization', async () => {
      const { service } = build({ held: ['create_processes'] });
      expect(await codeOf(service.createProcess(actor, 'p1', 'other-org-space', plan))).toBe('space_unavailable');
    });

    it('validates what the route pipe would have', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      expect(await codeOf(service.createProcess(actor, 'p1', SPACE, { ...plan, title: 'ab' }))).toBe('invalid_input');
      expect(await codeOf(service.createProcess(actor, 'p1', SPACE, { ...plan, requestType: 'Nonsense' }))).toBe('invalid_input');
      expect(processes.create).not.toHaveBeenCalled();
    });

    it('hands the parent process on, and sends none without one', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      await service.createProcess(actor, 'p1', SPACE, { ...plan, parentId: 'ab9b6567-28d1-4405-abab-002bcebec3d7' });
      expect(processes.create.mock.calls[0][2]).toMatchObject({ parent_id: 'ab9b6567-28d1-4405-abab-002bcebec3d7' });
      await service.createProcess(actor, 'p2', SPACE, plan);
      expect(processes.create.mock.calls[1][2].parent_id).toBeUndefined();
    });

    it('stores the level of the process in the hierarchy', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      await service.createProcess(actor, 'p1', SPACE, { ...plan, hierarchyLevelId: 'level_prozess' });
      expect(processes.create.mock.calls[0][2]).toMatchObject({ hierarchy_level_id: 'level_prozess' });
    });

    it('tries again when two took the same process key', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      processes.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint')).mockResolvedValueOnce({ id: 'p1' });
      await expect(service.createProcess(actor, 'p1', SPACE, plan)).resolves.toEqual({ adopted: false });
      expect(processes.create).toHaveBeenCalledTimes(2);
    });

    it('tries again after a gateway hiccup, which the reserved id makes safe', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      processes.create.mockRejectedValueOnce(new Error('An invalid response was received from the upstream server')).mockResolvedValueOnce({ id: 'p1' });
      await expect(service.createProcess(actor, 'p1', SPACE, plan)).resolves.toEqual({ adopted: false });
      expect(processes.create).toHaveBeenCalledTimes(2);
    });

    it('gives up after three tries', async () => {
      const { service, processes } = build({ held: ['create_processes'] });
      processes.create.mockRejectedValue(new Error('duplicate key value'));
      await expect(service.createProcess(actor, 'p1', SPACE, plan)).rejects.toThrow('duplicate');
      expect(processes.create).toHaveBeenCalledTimes(3);
    });
  });
});

describe('agent kinds', () => {
  it('runs parents first, and those who lose access last', () => {
    const order = ['space_member_remove', 'wiki_page', 'task', 'process', 'space_member_add', 'space'];
    expect([...order].sort((a, b) => rankOf(a) - rankOf(b))).toEqual([
      'space',
      'space_member_add',
      'process',
      'task',
      'wiki_page',
      'space_member_remove',
    ]);
    expect(rankOf('subtask')).toBe(rankOf('task'));
  });

  it('stores each kind where it lives', () => {
    expect(tableOf('space')).toBe('spaces');
    expect(tableOf('process')).toBe('business_processes');
    expect(tableOf('space_member_add')).toBeNull();
    expect(permOf('space_member_remove')).toBe('manage_members');
    expect(permOf('process')).toBe('create_processes');
  });

  it.each([
    ['Audit 2027', 'AUDIT2'],
    ['Überprüfung', 'UBERPR'],
    ['Q3', 'Q3'],
  ])('makes a key from %s', (name, key) => expect(spaceKeyBase(name)).toBe(key));

  it('makes a stable, valid key from symbols and emoji', () => {
    const key = spaceKeyBase('🚀🚀🚀');
    expect(key).toMatch(/^[A-Z0-9]{2,8}$/);
    expect(spaceKeyBase('🚀🚀🚀')).toBe(key);
    expect(spaceKeyBase('!!')).toMatch(/^[A-Z0-9]{2,8}$/);
  });

  it('takes the next free key', () => {
    expect(freeSpaceKey('Audit', new Set())).toBe('AUDIT');
    expect(freeSpaceKey('Audit', new Set(['AUDIT']))).toBe('AUDIT2');
    expect(freeSpaceKey('Audit', new Set(['AUDIT', 'AUDIT2']))).toBe('AUDIT3');
  });
});
