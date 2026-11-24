import { BadRequestException } from '@nestjs/common';
import type { InvitationsService } from '../../../invitations/invitations.service';
import type { MailService } from '../../../mail/mail.service';
import type { IJiraSourceAdapter } from '../../adapters/source-adapter.interface';
import type { UserMapper } from '../../mappers/user.mapper';
import type { NormalizedUser } from '../../model/normalized';
import { findJiraAdminIds, UsersStage } from './users.stage';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

const user = (overrides: Partial<NormalizedUser> = {}): NormalizedUser => ({
  sourceType: 'jira',
  sourceId: 'jdoe',
  username: 'jdoe',
  email: 'John.Doe@Example.com',
  displayName: 'John Doe',
  active: true,
  ...overrides,
});

/** The last call's argument, typed so assertions can reach into it. */
const lastArg = (mock: jest.Mock) =>
  (
    mock.mock.calls as [
      { role?: string; status?: string; metadata: Record<string, unknown> },
    ][]
  ).at(-1)![0];

/** The first call's argument, typed so assertions can reach into it. */
const firstArg = (mock: jest.Mock) =>
  (
    mock.mock.calls as [{ role?: string; metadata: Record<string, unknown> }][]
  )[0][0];

const item = (payload: Record<string, unknown>) =>
  ({ source_ref: payload.sourceId, payload }) as unknown as MigrationRunItemRow;

function setup(options: {
  inviteUsers?: boolean;
  dryRun?: boolean;
  existing?: Record<string, unknown> | null;
  placeholder?: boolean;
  createInvite?: jest.Mock;
  sendInvite?: jest.Mock;
}) {
  const resolveUser = jest.fn().mockResolvedValue({
    userId: 'ph-1',
    matchMethod: options.placeholder === false ? 'email' : 'placeholder',
    isPlaceholder: options.placeholder !== false,
    metadata: { match_method: 'placeholder' },
  });
  const createOrgInvitation =
    options.createInvite ??
    jest.fn().mockResolvedValue({
      invitation: {},
      invitationLink: 'https://app/invite',
      organizationName: 'Org',
    });
  const sendInvitation =
    options.sendInvite ?? jest.fn().mockResolvedValue(undefined);
  // Echoes the written row back, as the real upsert does.
  const recordMapping = jest.fn((i: Record<string, unknown>) =>
    Promise.resolve({
      target_id: i.targetId,
      status: i.status,
      source_key: i.sourceKey,
      target_table: i.targetTable,
      match_method: i.matchMethod,
      is_placeholder: i.isPlaceholder,
      source_email: i.sourceEmail,
      metadata: i.metadata,
    }),
  );
  const log = jest.fn().mockResolvedValue(undefined);
  const ctx = {
    orgId: 'org-1',
    dryRun: options.dryRun === true,
    job: { id: 'job-1', connection_id: 'conn-1', source_ref: 'XT' },
    run: {
      id: 'run-1',
      created_by: 'admin-1',
      config_snapshot: { options: { invite_users: options.inviteUsers } },
    },
    entityMap: {
      getTarget: jest.fn().mockResolvedValue(options.existing ?? null),
      recordMapping,
    },
    log,
  } as unknown as StageContext;
  const stage = new UsersStage(
    { resolveUser } as unknown as UserMapper,
    { createOrgInvitation } as unknown as InvitationsService,
    { sendInvitation } as unknown as MailService,
  );

  return {
    stage,
    ctx,
    createOrgInvitation,
    sendInvitation,
    recordMapping,
    log,
  };
}

describe('UsersStage invites (XE-T682)', () => {
  it('does not invite when the switch is off', async () => {
    const { stage, ctx, createOrgInvitation, recordMapping } = setup({});

    await stage.processItem(ctx, item({ ...user() }));

    expect(createOrgInvitation).not.toHaveBeenCalled();
    expect(lastArg(recordMapping).metadata).not.toHaveProperty('invite');
  });

  it('never invites during a dry run', async () => {
    const { stage, ctx, createOrgInvitation } = setup({
      inviteUsers: true,
      dryRun: true,
    });

    await stage.processItem(ctx, item({ ...user() }));

    expect(createOrgInvitation).not.toHaveBeenCalled();
  });

  it('invites a placeholder with its lower-cased email, Jira admins as admin, and records it', async () => {
    const { stage, ctx, createOrgInvitation, sendInvitation, recordMapping } =
      setup({ inviteUsers: true });

    await stage.processItem(ctx, item({ ...user(), jiraAdmin: true }));

    expect(createOrgInvitation).toHaveBeenCalledWith({
      email: 'john.doe@example.com',
      firstName: 'John',
      lastName: 'Doe',
      organizationId: 'org-1',
      role: 'admin',
      invitedByUserId: 'admin-1',
    });
    expect(sendInvitation).toHaveBeenCalledWith(
      'john.doe@example.com',
      expect.objectContaining({
        role: 'admin',
        invitationLink: 'https://app/invite',
      }),
    );
    expect(lastArg(recordMapping)).toMatchObject({
      status: 'placeholder',
      metadata: { invite: { status: 'sent', role: 'admin' } },
    });
  });

  it('marks the placeholder in the crosswalk before inviting, so the invite is not refused as a real member', async () => {
    const { stage, ctx, createOrgInvitation, recordMapping } = setup({
      inviteUsers: true,
    });

    await stage.processItem(ctx, item({ ...user() }));

    expect(recordMapping.mock.invocationCallOrder[0]).toBeLessThan(
      createOrgInvitation.mock.invocationCallOrder[0],
    );
    expect(firstArg(recordMapping)).toMatchObject({ status: 'placeholder' });
  });

  it('invites everyone else as member', async () => {
    const { stage, ctx, createOrgInvitation } = setup({ inviteUsers: true });

    await stage.processItem(ctx, item({ ...user() }));

    expect(firstArg(createOrgInvitation).role).toBe('member');
  });

  it.each([
    ['an inactive Jira user', { active: false }, 'inactive_in_source'],
    ['a user without email', { email: undefined }, 'no_usable_email'],
    ['a masked email', { email: 'j***@e***.com' }, 'no_usable_email'],
    ['a role address', { email: 'noreply@example.com' }, 'no_usable_email'],
  ])('skips %s', async (_label, overrides, reason) => {
    const { stage, ctx, createOrgInvitation, recordMapping } = setup({
      inviteUsers: true,
    });

    await stage.processItem(ctx, item({ ...user(overrides) }));

    expect(createOrgInvitation).not.toHaveBeenCalled();
    expect(lastArg(recordMapping).metadata.invite).toEqual({
      status: 'skipped',
      reason,
    });
  });

  it('does not invite a user matched to a real member', async () => {
    const { stage, ctx, createOrgInvitation } = setup({
      inviteUsers: true,
      placeholder: false,
    });

    await stage.processItem(ctx, item({ ...user() }));

    expect(createOrgInvitation).not.toHaveBeenCalled();
  });

  it('treats an invitation that is already pending as done, without a second email', async () => {
    const { stage, ctx, sendInvitation, recordMapping } = setup({
      inviteUsers: true,
      createInvite: jest
        .fn()
        .mockRejectedValue(
          new BadRequestException('Invitation already sent to this email'),
        ),
    });

    await stage.processItem(ctx, item({ ...user() }));

    expect(sendInvitation).not.toHaveBeenCalled();
    expect(lastArg(recordMapping).metadata.invite).toEqual({
      status: 'pending',
      role: 'member',
    });
  });

  it('keeps the mapping when the email cannot be sent', async () => {
    const { stage, ctx, recordMapping, log } = setup({
      inviteUsers: true,
      sendInvite: jest.fn().mockRejectedValue(new Error('smtp down')),
    });

    await expect(
      stage.processItem(ctx, item({ ...user() })),
    ).resolves.toMatchObject({
      kind: 'created',
      targetId: 'ph-1',
    });
    expect(lastArg(recordMapping).metadata.invite).toEqual({
      status: 'mail_failed',
      role: 'member',
    });
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('smtp down'),
      expect.anything(),
    );
  });

  it('a re-run with the switch on invites placeholders an earlier run left', async () => {
    const { stage, ctx, createOrgInvitation, recordMapping } = setup({
      inviteUsers: true,
      existing: {
        status: 'placeholder',
        target_id: 'ph-1',
        source_key: 'jdoe',
        target_table: 'users',
        match_method: 'placeholder',
        is_placeholder: true,
        source_email: 'John.Doe@Example.com',
        metadata: { display_name: 'John Doe' },
      },
    });

    await expect(
      stage.processItem(ctx, item({ ...user() })),
    ).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(createOrgInvitation).toHaveBeenCalledTimes(1);
    expect(lastArg(recordMapping)).toMatchObject({
      status: 'placeholder',
      targetId: 'ph-1',
      metadata: { display_name: 'John Doe', invite: { status: 'sent' } },
    });
  });
});

describe('findJiraAdminIds', () => {
  it('collects members of the Jira administrator groups only, across pages', async () => {
    const getGroupMembers = jest.fn(
      (group: string, opts?: { cursor?: string | null }) =>
        Promise.resolve(
          group === 'jira-administrators' && !opts?.cursor
            ? { items: [user({ sourceId: 'a1' })], nextCursor: '1', total: 2 }
            : {
                items: [user({ sourceId: group === 'id-site' ? 's1' : 'a2' })],
                nextCursor: null,
                total: 2,
              },
        ),
    );
    const adapter = {
      listGroups: jest.fn().mockResolvedValue([
        { sourceId: 'jira-administrators', name: 'jira-administrators' },
        { sourceId: 'id-site', name: 'site-admins' },
        { sourceId: 'jira-software-users', name: 'jira-software-users' },
      ]),
      getGroupMembers,
    } as unknown as IJiraSourceAdapter;

    const ids = await findJiraAdminIds(adapter, jest.fn());

    expect([...ids].sort()).toEqual(['a1', 'a2', 's1']);
    expect(getGroupMembers).not.toHaveBeenCalledWith(
      'jira-software-users',
      expect.anything(),
    );
  });

  it('returns an empty set and warns when groups cannot be read', async () => {
    const warn = jest.fn();
    const adapter = {
      listGroups: jest.fn().mockRejectedValue(new Error('403')),
    } as unknown as IJiraSourceAdapter;

    await expect(findJiraAdminIds(adapter, warn)).resolves.toEqual(new Set());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('403'));
  });
});
