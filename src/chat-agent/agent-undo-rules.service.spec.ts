import { ForbiddenException } from '@nestjs/common';

import { AgentUndoRulesService } from './agent-undo-rules.service';

const ME = { userId: 'me', organizationId: 'org-1' };
const held = (keys: string[]) => (_u: string, _o: string, key: string) => Promise.resolve(keys.includes(key));

function build(over: { org?: string[]; space?: string[]; row?: Record<string, unknown> | null; page?: boolean } = {}) {
  const row = over.row === undefined ? { space_id: 'real-space' } : over.row;
  const from = jest.fn(() => {
    const q: Record<string, unknown> = {};
    let org: unknown;
    q.select = () => q;
    q.eq = (col: string, value: unknown) => {
      if (col === 'organization_id') org = value;
      return q;
    };
    q.maybeSingle = () => Promise.resolve({ data: org === 'org-1' ? row : null, error: null });
    return q;
  });
  const permissions = {
    checkPermission: jest.fn(held(over.org ?? [])),
    hasSpacePermission: jest.fn((_u: string, _o: string, _s: string, key: string) => Promise.resolve((over.space ?? []).includes(key))),
    isAdminOrOwner: jest.fn().mockResolvedValue(false),
  };
  const wiki = {
    assertPageAccess: jest.fn(() => (over.page === false ? Promise.reject(new ForbiddenException()) : Promise.resolve())),
  };
  const service = new AgentUndoRulesService({ getClient: () => ({ from }) } as never, permissions as never, wiki as never);
  return { service, permissions, wiki, from };
}
const target = (kind: string) => ({ kind, entity_id: 'e1', organization_id: 'org-1' });

describe('AgentUndoRulesService', () => {
  it.each([
    ['task', 'can_delete_tasks'],
    ['subtask', 'can_delete_tasks'],
    ['process', 'can_delete_processes'],
  ])('%s: the org key is enough', async (kind, key) => {
    const { service } = build({ org: [key] });
    await expect(service.mayDelete(ME as never, target(kind))).resolves.toBe(true);
  });

  it.each([
    ['task', 'delete_tasks'],
    ['subtask', 'delete_tasks'],
    ['process', 'delete_processes'],
  ])('%s: or the key in the space the object is in now', async (kind, key) => {
    const { service, permissions } = build({ space: [key] });
    await expect(service.mayDelete(ME as never, target(kind))).resolves.toBe(true);
    expect(permissions.hasSpacePermission).toHaveBeenCalledWith('me', 'org-1', 'real-space', key);
  });

  it.each(['task', 'subtask', 'process', 'wiki_page'])('%s: a plain member has neither', async (kind) => {
    const { service } = build();
    await expect(service.mayDelete(ME as never, target(kind))).resolves.toBe(false);
  });

  it('a page needs the space key and its own page rules', async () => {
    const yes = build({ space: ['delete_wiki_pages'] });
    await expect(yes.service.mayDelete(ME as never, target('wiki_page'))).resolves.toBe(true);
    expect(yes.wiki.assertPageAccess).toHaveBeenCalledWith('e1', 'me', 'real-space', 'can_delete');

    const no = build({ space: ['delete_wiki_pages'], page: false });
    await expect(no.service.mayDelete(ME as never, target('wiki_page'))).resolves.toBe(false);
  });

  it('never asks for a space or member change', async () => {
    const { service, from } = build({ org: ['can_delete_tasks'] });
    await expect(service.mayDelete(ME as never, target('space'))).resolves.toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('finds the object only in the tenant of the person pressing', async () => {
    const { service, permissions } = build({ org: ['can_delete_tasks'] });
    await service.mayDelete({ userId: 'me', organizationId: 'org-9' } as never, target('task'));
    expect(permissions.checkPermission).not.toHaveBeenCalled();
  });

  it('leaves an object that is gone to the blockers, which say so', async () => {
    const { service } = build({ row: null });
    await expect(service.mayDelete(ME as never, target('task'))).resolves.toBe(true);
  });

  it('a link Undo asks plan edit rights now, never a task delete right (1.22.1)', async () => {
    const from = () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = () => Promise.resolve({ data: { plan_id: 'plan-x' }, error: null });
      return q;
    };
    const permissions = { checkPermission: jest.fn(), hasSpacePermission: jest.fn() };
    const plans = { planById: jest.fn().mockResolvedValue({ id: 'plan-x' }), canEdit: jest.fn().mockResolvedValue(false) };
    const service = new AgentUndoRulesService({ getClient: () => ({ from }) } as never, permissions as never, undefined, plans as never);
    await expect(service.mayDelete(ME as never, { kind: 'plan_link', entity_id: 'lnk', organization_id: 'org-1' })).resolves.toBe(false);
    plans.canEdit.mockResolvedValue(true);
    await expect(service.mayDelete(ME as never, { kind: 'plan_link', entity_id: 'lnk', organization_id: 'org-1' })).resolves.toBe(true);
    expect(permissions.checkPermission).not.toHaveBeenCalled();
    expect(permissions.hasSpacePermission).not.toHaveBeenCalled();
  });
});
