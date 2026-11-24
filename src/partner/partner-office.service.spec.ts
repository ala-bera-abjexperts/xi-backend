/**
 * @fileoverview Unit tests for PartnerOfficeService: Backoffice invitations are
 * locked to the partner's office email domain, reject when domain/role are
 * unconfigured, and 409 when the user is already a member or already invited;
 * removing an office user is org-scoped and refuses self- and owner-removal.
 * @module src/partner/partner-office.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PartnerOfficeService } from './partner-office.service';
import { PartnerRepository } from './partner.repository';

const ORG = 'org-1';
const INVITER = 'user-1';
const PROFILE = {
  office_email_domain: 'abjexperts.com',
  backoffice_role_id: 'role-backoffice',
};

function setup() {
  const chain: Record<string, jest.Mock> = {};
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });

  const repo = {
    insert: jest.fn().mockResolvedValue({ id: 'invitation-1', email: 'x' }),
    findOne: jest.fn().mockResolvedValue(PROFILE),
    client: { from: jest.fn(() => chain) },
  } as unknown as PartnerRepository;
  const service = new PartnerOfficeService(repo);

  return { service, repo, chain };
}

/** One recorded PostgREST query: which table, which .eq() filters, delete or not. */
interface Recorded {
  table: string;
  filters: Record<string, unknown>;
  deleted: boolean;
}

function setupRemove(member: { user_id: string; role: string } | null) {
  const queries: Recorded[] = [];

  const from = jest.fn((table: string) => {
    const rec: Recorded = { table, filters: {}, deleted: false };
    queries.push(rec);

    const q: Record<string, unknown> = {};
    const self = () => q;

    q.select = jest.fn(self);
    q.delete = jest.fn(() => {
      rec.deleted = true;

      return q;
    });
    q.eq = jest.fn((column: string, value: unknown) => {
      rec.filters[column] = value;

      return q;
    });
    q.maybeSingle = jest.fn().mockResolvedValue({ data: member, error: null });
    // Deletes are awaited without a terminal call - real PostgREST builders are
    // thenables, so the double must be one too.
    q.then = (resolve: (value: unknown) => unknown) =>
      resolve({ data: null, error: null });

    return q;
  });

  const repo = {
    findOne: jest.fn().mockResolvedValue(PROFILE),
    client: { from },
  } as unknown as PartnerRepository;

  return { service: new PartnerOfficeService(repo), repo, queries };
}

describe('PartnerOfficeService.removeMember', () => {
  const TARGET = 'user-2';

  it('refuses self-removal without touching any row', async () => {
    const { service, queries } = setupRemove({
      user_id: INVITER,
      role: 'member',
    });

    await expect(service.removeMember(ORG, INVITER, INVITER)).rejects.toThrow(
      BadRequestException,
    );
    expect(queries).toHaveLength(0);
  });

  it('throws NotFound when the target is not a member of this partner', async () => {
    const { service } = setupRemove(null);

    await expect(service.removeMember(ORG, INVITER, TARGET)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('scopes the member lookup to the caller org, so another partner’s user 404s', async () => {
    const { service, queries } = setupRemove(null);

    await expect(
      service.removeMember(ORG, INVITER, 'user-of-other-partner'),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The service-role client bypasses RLS: this filter is the tenant boundary.
    expect(queries[0]).toMatchObject({
      table: 'organization_members',
      filters: {
        organization_id: ORG,
        user_id: 'user-of-other-partner',
      },
      deleted: false,
    });
  });

  it('refuses to remove an owner of the partner org', async () => {
    const { service, queries } = setupRemove({
      user_id: TARGET,
      role: 'owner',
    });

    await expect(service.removeMember(ORG, INVITER, TARGET)).rejects.toThrow(
      ForbiddenException,
    );
    expect(queries.some((q) => q.deleted)).toBe(false);
  });

  it('drops the Backoffice assignment and the membership, both org-scoped', async () => {
    const { service, queries } = setupRemove({
      user_id: TARGET,
      role: 'member',
    });

    await expect(service.removeMember(ORG, INVITER, TARGET)).resolves.toEqual({
      success: true,
    });

    const deletes = queries.filter((q) => q.deleted);

    // Role assignment first: if the membership delete fails, the user is left a
    // plain member rather than evicted while still holding partner permissions.
    expect(deletes.map((d) => d.table)).toEqual([
      'user_role_assignments',
      'organization_members',
    ]);
    expect(deletes[0].filters).toEqual({
      organization_id: ORG,
      user_id: TARGET,
      role_id: 'role-backoffice',
    });
    expect(deletes[1].filters).toEqual({
      organization_id: ORG,
      user_id: TARGET,
    });
    // Nothing else was written.
    expect(deletes).toHaveLength(2);
  });

  it('still removes the membership when the partner has no Backoffice role provisioned', async () => {
    const { service, repo, queries } = setupRemove({
      user_id: TARGET,
      role: 'member',
    });

    (repo.findOne as jest.Mock).mockResolvedValue({
      office_email_domain: 'abjexperts.com',
      backoffice_role_id: null,
    });

    await expect(service.removeMember(ORG, INVITER, TARGET)).resolves.toEqual({
      success: true,
    });

    const deletes = queries.filter((q) => q.deleted);

    expect(deletes.map((d) => d.table)).toEqual(['organization_members']);
  });
});

describe('PartnerOfficeService.inviteBackoffice', () => {
  it('throws NotFound when the partner profile is missing', async () => {
    const { service, repo } = setup();
    (repo.findOne as jest.Mock).mockResolvedValue(null);

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'lara.brandt@abjexperts.com',
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when the office email domain is not configured', async () => {
    const { service, repo } = setup();
    (repo.findOne as jest.Mock).mockResolvedValue({
      office_email_domain: null,
      backoffice_role_id: 'role-backoffice',
    });

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'lara.brandt@abjexperts.com',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the Backoffice role has not been provisioned', async () => {
    const { service, repo } = setup();
    (repo.findOne as jest.Mock).mockResolvedValue({
      office_email_domain: 'abjexperts.com',
      backoffice_role_id: null,
    });

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'lara.brandt@abjexperts.com',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an email outside the locked office domain', async () => {
    const { service } = setup();

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'intruder@othercompany.com',
      } as never),
    ).rejects.toThrow(/abjexperts\.com/);
  });

  it('throws 409 when the user is already a partner member', async () => {
    const { service, chain } = setup();
    chain.maybeSingle.mockResolvedValueOnce({
      data: { user_id: 'existing-1' },
      error: null,
    });

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'lara.brandt@abjexperts.com',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 409 when a pending invite already exists', async () => {
    const { service, chain } = setup();
    chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // member check
      .mockResolvedValueOnce({ data: { id: 'invite-existing' }, error: null });

    await expect(
      service.inviteBackoffice(ORG, INVITER, {
        email: 'lara.brandt@abjexperts.com',
      } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates an invitation carrying the Backoffice role for a valid domain email', async () => {
    const { service, repo } = setup();

    const result = await service.inviteBackoffice(ORG, INVITER, {
      email: 'Lara.Brandt@abjexperts.com',
      first_name: 'Lara',
      last_name: 'Brandt',
    } as never);

    expect(repo.insert).toHaveBeenCalledWith(
      'invitations',
      expect.objectContaining({
        organization_id: ORG,
        email: 'lara.brandt@abjexperts.com',
        // Deliberately 'member': accept_invitation_atomic copies this into
        // organization_members.role, and effective permissions start from
        // DEFAULT_PERMISSIONS_BY_ROLE[role]. 'admin' would give a back-office
        // invitee full admin over the partner org AND auto-add them to every
        // space via sync_org_member_to_spaces. The partner permissions come from
        // custom_role_id instead, so 'member' is the correct least privilege.
        role: 'member',
        custom_role_id: 'role-backoffice',
        invited_by: INVITER,
      }),
    );
    expect(result.accept_path).toMatch(/^\/auth\/accept-invitation\?token=/);
  });

  it('never grants a base role that would escalate a Backoffice invitee to org admin', async () => {
    const { service, repo } = setup();

    await service.inviteBackoffice(ORG, INVITER, {
      email: 'someone@abjexperts.com',
    } as never);

    const [, payload] = (repo.insert as jest.Mock).mock.calls.find(
      ([table]) => table === 'invitations',
    ) as [string, { role: string; custom_role_id: string }];

    expect(payload.role).not.toBe('admin');
    expect(payload.role).not.toBe('owner');
    // The partner scope must still arrive via the Backoffice custom role.
    expect(payload.custom_role_id).toBe('role-backoffice');
  });
});
