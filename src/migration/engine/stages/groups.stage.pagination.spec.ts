import { GroupsStage } from './groups.stage';
import type { StageContext } from './stage.interface';
import type { NormalizedGroup } from '../../model/normalized';

type EnrolMembers = (
  ctx: StageContext,
  group: NormalizedGroup,
  groupId: string,
) => Promise<Record<string, unknown>>;

function enrol(stage: GroupsStage): EnrolMembers {
  const target = stage as unknown as { enrolMembers: EnrolMembers };

  return (ctx, group, groupId) => target.enrolMembers(ctx, group, groupId);
}

describe('GroupsStage Cloud membership pagination', () => {
  it('continues until the source cursor ends instead of truncating at 1000 members', async () => {
    let page = 0;
    const adapter = {
      product: 'jira',
      deployment: 'cloud',
      listProjects: jest.fn(),
      getGroupMembers: jest.fn(() => {
        page += 1;

        return Promise.resolve({
          items: [{ sourceId: `user-${page}` }],
          nextCursor: page < 21 ? String(page) : null,
          total: 21,
        });
      }),
    };
    const userGroups = { addMember: jest.fn().mockResolvedValue(undefined) };
    const stage = new GroupsStage(userGroups as never);
    const ctx = {
      orgId: 'org-1',
      job: { connection_id: 'connection-1' },
      dryRun: false,
      getAdapter: () => Promise.resolve(adapter),
      entityMap: {
        getTarget: jest.fn((_org, _connection, _type, sourceId) =>
          Promise.resolve({
            status: 'mapped',
            target_id: `target-${sourceId}`,
            is_placeholder: false,
          }),
        ),
      },
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;

    const result = await enrol(stage)(
      ctx,
      { sourceId: 'group-1', name: 'Developers' },
      'target-group',
    );

    expect(adapter.getGroupMembers).toHaveBeenCalledTimes(21);
    expect(userGroups.addMember).toHaveBeenCalledTimes(21);
    expect(result).toEqual(expect.objectContaining({ members_added: 21 }));
    expect(result).not.toHaveProperty('members_truncated');
  });

  it('fails explicitly when a source repeats the same member cursor', async () => {
    const adapter = {
      product: 'jira',
      deployment: 'cloud',
      listProjects: jest.fn(),
      getGroupMembers: jest.fn().mockResolvedValue({
        items: [{ sourceId: 'user-1' }],
        nextCursor: 'same',
        total: null,
      }),
    };
    const stage = new GroupsStage({
      addMember: jest.fn().mockResolvedValue(undefined),
    } as never);
    const ctx = {
      orgId: 'org-1',
      job: { connection_id: 'connection-1' },
      dryRun: false,
      getAdapter: () => Promise.resolve(adapter),
      entityMap: {
        getTarget: jest.fn().mockResolvedValue({
          status: 'mapped',
          target_id: 'target-user',
          is_placeholder: false,
        }),
      },
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;

    await expect(
      enrol(stage)(
        ctx,
        { sourceId: 'group-1', name: 'Developers' },
        'target-group',
      ),
    ).rejects.toThrow(/repeated.*cursor/i);
  });
});
