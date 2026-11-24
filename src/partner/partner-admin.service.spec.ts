/**
 * @fileoverview Unit tests for PartnerAdminService: provision() flags the org as
 * a partner, ensures the system Backoffice + Partner Admin roles (created once,
 * reused after), assigns Partner Admin to the org's owners, upserts the partner
 * profile, and grants the module_partners entitlement; listAllLeads() enriches
 * the owner's review queue with the submitting partner's name.
 * @module src/partner/partner-admin.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntitlementsService } from '../licensing/entitlements.service';
import { PartnerAdminService } from './partner-admin.service';
import { PartnerRepository } from './partner.repository';

const ACTOR = 'actor-1';
const ORG = 'org-1';
const OWNER = 'owner-1';
const LICENSE = 'license-1';

/**
 * The Supabase query builder is chainable and terminal methods resolve, so each
 * table gets its own chain whose terminal value we can set per test. Keyed by
 * table name because provision() touches five of them.
 */
function setup(overrides: { orgRow?: unknown; liveLicense?: unknown } = {}) {
  const chains: Record<string, Record<string, jest.Mock>> = {};

  const makeChain = (terminal: { data: unknown; error: unknown }) => {
    const chain: Record<string, jest.Mock> = {};
    const self = () => chain;

    for (const m of ['update', 'eq', 'is', 'in', 'select', 'upsert']) {
      chain[m] = jest.fn(self);
    }

    chain.maybeSingle = jest.fn().mockResolvedValue(terminal);
    // Non-.maybeSingle() terminals (e.g. .select() on a list) resolve via then.
    chain.then = undefined as never;

    return chain;
  };

  chains.organizations = makeChain({
    data: 'orgRow' in overrides ? overrides.orgRow : { id: ORG },
    error: null,
  });
  chains.organization_members = makeChain({ data: null, error: null });
  chains.user_role_assignments = makeChain({ data: [], error: null });
  chains.organization_licenses = makeChain({
    data: overrides.liveLicense ?? null,
    error: null,
  });
  chains.organization_license_feature_overrides = makeChain({
    data: null,
    error: null,
  });

  // owners list + existing assignments are awaited directly (no .maybeSingle()).
  chains.organization_members.select = jest
    .fn()
    .mockReturnValue(chains.organization_members);
  chains.organization_members.eq = jest.fn(function (this: unknown, ...args) {
    // second .eq('role','owner') is the terminal await
    return args[0] === 'role'
      ? Promise.resolve({ data: [{ user_id: OWNER }], error: null })
      : chains.organization_members;
  } as never);

  chains.user_role_assignments.eq = jest.fn(function (this: unknown, ...args) {
    return args[0] === 'role_id'
      ? Promise.resolve({ data: [], error: null })
      : chains.user_role_assignments;
  } as never);

  chains.organization_license_feature_overrides.upsert = jest
    .fn()
    .mockResolvedValue({ data: null, error: null });

  const repo = {
    insert: jest.fn(),
    insertMany: jest.fn().mockResolvedValue([]),
    updateById: jest.fn().mockResolvedValue({ id: 'profile-1' }),
    findOne: jest.fn(),
    list: jest.fn().mockResolvedValue({ data: [], totalCount: 0 }),
    client: { from: jest.fn((table: string) => chains[table]) },
  } as unknown as PartnerRepository;

  // A licensed (not grandfathered) org: provisioning must grant module_partners.
  const entitlements = {
    bust: jest.fn(),
    getEffectiveEntitlements: jest
      .fn()
      .mockResolvedValue({ grandfathered: false }),
  } as unknown as EntitlementsService;
  const service = new PartnerAdminService(repo, entitlements);

  return { service, repo, entitlements, chains };
}

const dto = {
  organization_id: ORG,
  company_name: 'ABJ Experts',
  office_email_domain: 'abjexperts.com',
  kickback_percent: 12.5,
};

/** findOne is called for: custom_roles x2, partner_profiles, license_plans. */
function findOneImpl(roles: Record<string, unknown>) {
  return (table: string, filters: Record<string, unknown>) => {
    if (table === 'custom_roles') return roles[filters.name as string] ?? null;
    if (table === 'partner_profiles') return roles.profile ?? null;
    if (table === 'license_plans') return { id: 'plan-partner-custom' };

    return null;
  };
}

describe('PartnerAdminService.provision', () => {
  it('flags the org, creates both system roles, and inserts a new profile', async () => {
    const { service, repo, chains } = setup();

    (repo.findOne as jest.Mock).mockImplementation(findOneImpl({}));
    (repo.insert as jest.Mock)
      .mockResolvedValueOnce({ id: 'role-backoffice' }) // custom_roles: Backoffice
      .mockResolvedValueOnce({ id: 'profile-new' }) // partner_profiles
      .mockResolvedValueOnce({ id: 'role-partner-admin' }) // custom_roles: Partner Admin
      .mockResolvedValueOnce({ id: LICENSE }); // organization_licenses

    const result = await service.provision(ACTOR, dto as never);

    expect(chains.organizations.update).toHaveBeenCalledWith({
      is_partner: true,
    });
    expect(repo.insert).toHaveBeenCalledWith(
      'custom_roles',
      expect.objectContaining({
        organization_id: ORG,
        name: 'Backoffice',
        base_role: 'admin',
        is_system: true,
        permissions: expect.objectContaining({
          can_manage_partner_licenses: true,
          can_manage_partner_invoices: true,
        }),
      }),
    );
    expect(repo.insert).toHaveBeenCalledWith(
      'partner_profiles',
      expect.objectContaining({
        organization_id: ORG,
        company_name: 'ABJ Experts',
        office_email_domain: 'abjexperts.com',
        kickback_percent: 12.5,
        backoffice_role_id: 'role-backoffice',
      }),
    );
    expect(result).toMatchObject({
      organization_id: ORG,
      backoffice_role_id: 'role-backoffice',
    });
  });

  it('reuses the existing roles and updates the existing profile', async () => {
    const { service, repo } = setup();

    (repo.findOne as jest.Mock).mockImplementation(
      findOneImpl({
        Backoffice: { id: 'role-existing' },
        'Partner Admin': { id: 'role-pa-existing' },
        profile: { id: 'profile-existing' },
      }),
    );
    (repo.insert as jest.Mock).mockResolvedValue({ id: LICENSE });

    const result = await service.provision(ACTOR, dto as never);

    expect(repo.insert).not.toHaveBeenCalledWith(
      'custom_roles',
      expect.anything(),
    );
    expect(repo.updateById).toHaveBeenCalledWith(
      'partner_profiles',
      'profile-existing',
      expect.objectContaining({
        backoffice_role_id: 'role-existing',
        updated_by: ACTOR,
      }),
    );
    expect(result.backoffice_role_id).toBe('role-existing');
    expect(result.partner_admin_role_id).toBe('role-pa-existing');
  });

  it('404s for a non-existent organization instead of half-provisioning it', async () => {
    // .maybeSingle() returns data:null (not an error) for an unknown id.
    const { service, repo } = setup({ orgRow: null });

    (repo.findOne as jest.Mock).mockImplementation(findOneImpl({}));

    await expect(service.provision(ACTOR, dto as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('does not downgrade a grandfathered org with a partner licence', async () => {
    const { service, repo, entitlements } = setup();
    (entitlements.getEffectiveEntitlements as jest.Mock).mockResolvedValue({
      grandfathered: true,
    });
    (repo.findOne as jest.Mock).mockImplementation(findOneImpl({}));
    (repo.insert as jest.Mock).mockResolvedValue({ id: 'row-1' });

    const result = await service.provision(ACTOR, dto as never);

    expect(result.license_id).toBeNull();
    expect(repo.insert).not.toHaveBeenCalledWith(
      'organization_licenses',
      expect.anything(),
    );
  });

  it('grants module_partners and busts the entitlement cache', async () => {
    const { service, repo, entitlements, chains } = setup();

    (repo.findOne as jest.Mock).mockImplementation(findOneImpl({}));
    (repo.insert as jest.Mock).mockResolvedValue({ id: LICENSE });

    const result = await service.provision(ACTOR, dto as never);

    // No live licence existed -> one is created so the override has a parent and
    // the org stops resolving as "grandfathered".
    expect(repo.insert).toHaveBeenCalledWith(
      'organization_licenses',
      expect.objectContaining({
        organization_id: ORG,
        status: 'active',
        plan_id: 'plan-partner-custom',
      }),
    );
    expect(
      chains.organization_license_feature_overrides.upsert,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        feature_key: 'module_partners',
        entitlement_value: true,
        reason: 'partner_provisioning',
      }),
      expect.objectContaining({
        onConflict: 'organization_license_id,feature_key',
      }),
    );
    expect(entitlements.bust).toHaveBeenCalledWith(ORG);
    expect(result.license_id).toBe(LICENSE);
  });

  it('assigns the Partner Admin role to the org owners', async () => {
    const { service, repo } = setup();

    (repo.findOne as jest.Mock).mockImplementation(findOneImpl({}));
    (repo.insert as jest.Mock)
      .mockResolvedValueOnce({ id: 'role-backoffice' })
      .mockResolvedValueOnce({ id: 'profile-new' })
      .mockResolvedValueOnce({ id: 'role-partner-admin' })
      .mockResolvedValueOnce({ id: LICENSE });

    const result = await service.provision(ACTOR, dto as never);

    expect(repo.insertMany).toHaveBeenCalledWith(
      'user_role_assignments',
      expect.arrayContaining([
        expect.objectContaining({
          organization_id: ORG,
          user_id: OWNER,
          role_id: 'role-partner-admin',
        }),
      ]),
    );
    expect(result.owners_assigned).toBe(1);
  });
});

describe('PartnerAdminService.listAllLeads', () => {
  it('flattens the submitting partner name onto each lead and keeps the filters paginated', async () => {
    const { service, repo } = setup();

    (repo.list as jest.Mock).mockResolvedValue({
      data: [
        {
          id: 'lead-1',
          organization_id: ORG,
          customer_company_name: 'Helena Inc',
          partner_organization: { id: ORG, name: 'ABJ Experts', slug: 'abj' },
        },
      ],
      totalCount: 1,
    });

    const result = await service.listAllLeads({
      status: 'submitted',
      page: 2,
      pageSize: 10,
    });

    // The embed MUST name the FK: partner_leads references organizations twice
    // (partner + resolved customer), so an unqualified embed is ambiguous.
    expect(repo.list).toHaveBeenCalledWith(
      'partner_leads',
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        filters: { is_deleted: false, status: 'submitted' },
        select: expect.stringContaining(
          'organizations!partner_leads_organization_id_fkey',
        ),
      }),
    );
    expect(result.totalCount).toBe(1);
    expect(result.data[0]).toMatchObject({
      id: 'lead-1',
      partner_name: 'ABJ Experts',
      partner_slug: 'abj',
    });
    // The raw embed is flattened away rather than leaked to the client.
    expect(result.data[0]).not.toHaveProperty('partner_organization');
  });

  it('nulls the partner name rather than throwing when the embed is absent', async () => {
    const { service, repo } = setup();

    (repo.list as jest.Mock).mockResolvedValue({
      data: [{ id: 'lead-1', organization_id: ORG }],
      totalCount: 1,
    });

    const result = await service.listAllLeads({});

    expect(result.data[0]).toMatchObject({
      partner_name: null,
      partner_slug: null,
    });
  });
});

// XE-T738: the global module price list partners build packages from.
describe('PartnerAdminService price list', () => {
  function priceListSetup() {
    const repo = {
      insert: jest.fn().mockResolvedValue({ id: 'item-1' }),
      updateById: jest.fn().mockResolvedValue({ id: 'item-1' }),
      findById: jest.fn().mockResolvedValue({
        id: 'item-1',
        item_type: 'module',
        feature_key: 'module_tasks',
      }),
    } as unknown as PartnerRepository;
    const service = new PartnerAdminService(repo, {} as EntitlementsService);

    return { service, repo };
  }

  const ENTRY = {
    item_type: 'module' as const,
    feature_key: 'module_tasks',
    name: 'Tasks',
    default_unit_price_cents: 1400,
  };

  it('creates a catalog module and mirrors name into label', async () => {
    const { service, repo } = priceListSetup();

    await service.createResellableItem(ACTOR, ENTRY);

    expect(repo.insert).toHaveBeenCalledWith(
      'partner_resellable_items',
      expect.objectContaining({
        feature_key: 'module_tasks',
        label: 'Tasks',
        created_by: ACTOR,
      }),
    );
  });

  it('rejects a key that is not in the feature catalog', async () => {
    const { service, repo } = priceListSetup();

    await expect(
      service.createResellableItem(ACTOR, {
        ...ENTRY,
        feature_key: 'module_nope',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects a limit key sold as a module row', async () => {
    const { service } = priceListSetup();

    await expect(
      service.createResellableItem(ACTOR, {
        ...ENTRY,
        feature_key: 'limit_users',
      }),
    ).rejects.toThrow('module key');
  });

  it('turns a duplicate key into a readable 409', async () => {
    const { service, repo } = priceListSetup();
    (repo.insert as jest.Mock).mockRejectedValue(
      new ConflictException('23505'),
    );

    await expect(service.createResellableItem(ACTOR, ENTRY)).rejects.toThrow(
      '"module_tasks" is already on the price list',
    );
  });

  it('deactivates instead of deleting', async () => {
    const { service, repo } = priceListSetup();

    await service.deactivateResellableItem('item-1', ACTOR);

    expect(repo.updateById).toHaveBeenCalledWith(
      'partner_resellable_items',
      'item-1',
      { is_active: false, updated_by: ACTOR },
    );
  });

  it('404s when editing a missing entry', async () => {
    const { service, repo } = priceListSetup();
    (repo.findById as jest.Mock).mockResolvedValue(null);

    await expect(
      service.updateResellableItem('missing', ACTOR, { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
