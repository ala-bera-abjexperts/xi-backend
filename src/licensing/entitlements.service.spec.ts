import { Logger } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import type {
  LicenseFeatureRow,
  LicenseOverrideRow,
  LicensingRepository,
  OrganizationLicenseRow,
} from './licensing.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_ID_2 = '44444444-4444-4444-8444-444444444444';

/** Live statuses, mirroring the `.in('status', ...)` filter in getLiveLicenses. */
const LIVE = ['trialing', 'active', 'past_due', 'suspended'];

const PAST = '2026-01-01T00:00:00Z';
const NEWER = '2026-06-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';

function license(
  over: Partial<OrganizationLicenseRow> & { id: string },
): OrganizationLicenseRow {
  return {
    organization_id: ORG,
    plan_id: PLAN_ID,
    status: 'active',
    seats_purchased: 10,
    seats_used: 0,
    starts_at: PAST,
    ends_at: null,
    trial_ends_at: null,
    current_period_start: null,
    current_period_end: null,
    cancelled_at: null,
    suspension_reason: null,
    external_provider: null,
    external_customer_id: null,
    external_subscription_id: null,
    metadata: {},
    created_by: null,
    updated_by: null,
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

function override(
  over: Partial<LicenseOverrideRow> & {
    id: string;
    organization_license_id: string;
    feature_key: string;
  },
): LicenseOverrideRow {
  return {
    entitlement_value: true,
    reason: null,
    expires_at: null,
    created_by: null,
    updated_by: null,
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

function planFeature(
  over: Partial<LicenseFeatureRow> & { id: string; feature_key: string },
): LicenseFeatureRow {
  return {
    plan_id: PLAN_ID,
    feature_name: over.feature_key,
    description: null,
    feature_type: 'boolean',
    entitlement_value: true,
    is_metered: false,
    display_order: 1,
    metadata: {},
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

/**
 * Repository double whose reads mirror the real SQL contracts:
 *  - getLiveLicenses filters status server-side and orders created_at DESC;
 *  - getLatestInactiveLicense is the mirror image: cancelled/expired only,
 *    newest first, at most one. It exists because getLiveLicenses hides the
 *    very row the resolver must report, which is what made LICENSE_INACTIVE
 *    unreachable;
 *  - listOverrides joins on organization_id ONLY — no status/window filter, so
 *    it returns overrides owned by cancelled and not-yet-started licenses too.
 *    Modelling that faithfully is what makes the bleed regression detectable.
 */
function buildRepository(fixture: {
  licenses: OrganizationLicenseRow[];
  overrides?: LicenseOverrideRow[];
  planFeatures?: Record<string, LicenseFeatureRow[]>;
  /** Org predates the grandfather cutoff (default: yes, like every legacy org). */
  createdBeforeCutoff?: boolean;
}) {
  const all = [...(fixture.overrides ?? [])].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  return {
    getLiveLicenses: jest
      .fn()
      .mockResolvedValue(
        fixture.licenses
          .filter((l) => LIVE.includes(l.status))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      ),
    getLatestInactiveLicense: jest
      .fn()
      .mockResolvedValue(
        fixture.licenses
          .filter((l) => l.status === 'cancelled' || l.status === 'expired')
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null,
      ),
    listPlanFeatures: jest
      .fn()
      .mockImplementation((planId: string) =>
        Promise.resolve(fixture.planFeatures?.[planId] ?? []),
      ),
    listOverrides: jest.fn().mockResolvedValue(all),
    isCreatedBeforeGrandfatherCutoff: jest
      .fn()
      .mockResolvedValue(fixture.createdBeforeCutoff ?? true),
    listOverridesForLicenses: jest
      .fn()
      .mockImplementation((_organizationId: string, licenseIds: string[]) =>
        Promise.resolve(
          all.filter((o) => licenseIds.includes(o.organization_license_id)),
        ),
      ),
  };
}

describe('EntitlementsService', () => {
  let repository: ReturnType<typeof buildRepository>;
  let service: EntitlementsService;

  const build = (fixture: Parameters<typeof buildRepository>[0]) => {
    repository = buildRepository(fixture);
    service = new EntitlementsService(
      repository as unknown as LicensingRepository,
    );
    return service;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('grandfather cutoff (new orgs)', () => {
    it('puts a never-licensed org created AFTER the cutoff on the free tier', async () => {
      const entitlements = await build({
        licenses: [],
        createdBeforeCutoff: false,
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBeNull();
      expect(entitlements.getLimit('limit_users')).toBe(5);
    });

    it('keeps a never-licensed org created BEFORE the cutoff unlimited', async () => {
      const entitlements = await build({
        licenses: [],
        createdBeforeCutoff: true,
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.grandfathered).toBe(true);
      expect(entitlements.getLimit('limit_users')).toBeNull();
    });

    it('never consults the cutoff for a licensed org', async () => {
      await build({
        licenses: [license({ id: 'lic-1' })],
      }).getEffectiveEntitlements(ORG);

      expect(
        repository.isCreatedBeforeGrandfatherCutoff,
      ).not.toHaveBeenCalled();
    });
  });

  describe('grandfathering posture', () => {
    it('grants full access when the tenant has no license row at all', async () => {
      const entitlements = await build({
        licenses: [],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.grandfathered).toBe(true);
      expect(entitlements.licenseStatus).toBeNull();
      expect(entitlements.has('module_wiki')).toBe(true);
      expect(entitlements.has('anything_at_all')).toBe(true);
      expect(entitlements.getLimit('limit_users')).toBeNull();
      expect(entitlements.raw.size).toBe(0);
    });

    it('LOCKS to the free tier when every license is past its ends_at', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-expired', ends_at: PAST })],
      }).getEffectiveEntitlements(ORG);

      // A lapsed paid period must not grant MORE than the plan it replaced.
      // Nothing flips `status` when ends_at passes, so it is reported as
      // 'expired' and the tenant drops to free rather than to unlimited.
      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBe('expired');

      // Free-tier modules survive; premium ones do not.
      expect(entitlements.has('module_wiki')).toBe(true);
      expect(entitlements.has('module_site_studio')).toBe(false);
      expect(entitlements.getLimit('limit_users')).toBe(5);
    });

    it('reports the status of a non-live license so the policy guard can deny it', async () => {
      // getLiveLicenses filters status in SQL; this asserts the resolver's own
      // defence in depth if that query ever regresses.
      repository = buildRepository({ licenses: [] });
      repository.getLiveLicenses.mockResolvedValue([
        license({ id: 'lic-cancelled', status: 'cancelled' }),
      ]);
      service = new EntitlementsService(
        repository as unknown as LicensingRepository,
      );

      const entitlements = await service.getEffectiveEntitlements(ORG);

      // grandfathered:false is the whole point. It is the flag FeatureGuard and
      // the frontend FeatureRouteGuard both key off, so reporting `true` here
      // would 403 the API while the UI still rendered the module.
      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBe('cancelled');
      // The status came from the row already in hand, not a second query.
      expect(repository.getLatestInactiveLicense).not.toHaveBeenCalled();
      // A cancelled license must never contribute entitlements.
      expect(repository.listOverridesForLicenses).not.toHaveBeenCalled();
    });

    it('LOCKS to the free tier when the only license was cancelled', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-cancelled', status: 'cancelled' })],
      }).getEffectiveEntitlements(ORG);

      // The regression this guards: cancelling used to make the tenant
      // grandfathered, i.e. cancelling GRANTED unlimited access.
      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBe('cancelled');
      expect(entitlements.has('module_tasks')).toBe(true);
      expect(entitlements.has('module_portfolios')).toBe(false);
      expect(entitlements.has('feature_ai_assist')).toBe(false);
      expect(entitlements.has('anything_at_all')).toBe(false);
    });
  });

  describe('single live license', () => {
    it('resolves catalog default < plan < override, and reports provenance', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-1' })],
        planFeatures: {
          [PLAN_ID]: [planFeature({ id: 'f-1', feature_key: 'module_tasks' })],
        },
        overrides: [
          override({
            id: 'o-1',
            organization_license_id: 'lic-1',
            feature_key: 'limit_users',
            entitlement_value: 42,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBe('active');

      // override wins
      expect(entitlements.getLimit('limit_users')).toBe(42);
      expect(entitlements.raw.get('limit_users')?.source).toBe('override');
      // plan wins over the catalog default
      expect(entitlements.has('module_tasks')).toBe(true);
      expect(entitlements.raw.get('module_tasks')?.source).toBe('plan');
      // untouched catalog key keeps its default (module_wiki defaults to false)
      expect(entitlements.has('module_wiki')).toBe(false);
      expect(entitlements.raw.get('module_wiki')?.source).toBe(
        'catalog_default',
      );
      expect(entitlements.getLimit('limit_spaces')).toBe(3);
    });

    it('keeps custom plan keys and override-only keys outside the catalog', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-1' })],
        planFeatures: {
          [PLAN_ID]: [
            planFeature({ id: 'f-1', feature_key: 'custom_plan_key' }),
          ],
        },
        overrides: [
          override({
            id: 'o-1',
            organization_license_id: 'lic-1',
            feature_key: 'custom_override_key',
            entitlement_value: true,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.has('custom_plan_key')).toBe(true);
      expect(entitlements.raw.get('custom_plan_key')?.source).toBe('plan');
      expect(entitlements.has('custom_override_key')).toBe(true);
      expect(entitlements.raw.get('custom_override_key')?.source).toBe(
        'override',
      );
    });

    it('ignores an override that has already expired', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-1' })],
        overrides: [
          override({
            id: 'o-1',
            organization_license_id: 'lic-1',
            feature_key: 'limit_users',
            entitlement_value: 999,
            expires_at: PAST,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBe(5);
      expect(entitlements.raw.get('limit_users')?.source).toBe(
        'catalog_default',
      );
    });

    it('treats a non-numeric limit as unlimited rather than summing it to zero', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-1' })],
        overrides: [
          override({
            id: 'o-1',
            organization_license_id: 'lic-1',
            feature_key: 'limit_users',
            entitlement_value: 'not-a-number',
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      // Fail OPEN. Coercing malformed data to 0 would lock the tenant out.
      expect(entitlements.getLimit('limit_users')).toBeNull();
    });
  });

  describe('starts_at window', () => {
    it('does not grant a lone license that has not started yet', async () => {
      const entitlements = await build({
        licenses: [license({ id: 'lic-future', starts_at: FUTURE })],
        overrides: [
          override({
            id: 'o-future',
            organization_license_id: 'lic-future',
            feature_key: 'limit_users',
            entitlement_value: 300,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      // No in-window license ⇒ the tenant resolves exactly as if it had none
      // (here: a legacy org, so grandfathered), never licensed-for-300.
      expect(entitlements.getLimit('limit_users')).not.toBe(300);
      expect(entitlements.grandfathered).toBe(true);
      expect(repository.listOverridesForLicenses).not.toHaveBeenCalled();
    });

    it('puts a lapsed tenant whose only live license is future-dated on the free tier', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-old', status: 'expired', created_at: PAST }),
          license({ id: 'lic-future', starts_at: FUTURE, created_at: NEWER }),
        ],
      }).getEffectiveEntitlements(ORG);

      // Before: a not-yet-started renewal handed the lapsed tenant UNLIMITED
      // access until it started. Now it stays on the free tier until then.
      expect(entitlements.grandfathered).toBe(false);
      expect(entitlements.licenseStatus).toBe('expired');
      expect(entitlements.getLimit('limit_users')).toBe(5);
    });

    it('ignores a not-yet-started license while another is in window', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-now', created_at: PAST }),
          license({ id: 'lic-later', starts_at: FUTURE, created_at: NEWER }),
        ],
        overrides: [
          override({
            id: 'o-now',
            organization_license_id: 'lic-now',
            feature_key: 'limit_users',
            entitlement_value: 10,
          }),
          override({
            id: 'o-later',
            organization_license_id: 'lic-later',
            feature_key: 'limit_users',
            entitlement_value: 500,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBe(10);
      expect(repository.listOverridesForLicenses).toHaveBeenCalledWith(ORG, [
        'lic-now',
      ]);
    });
  });

  describe('cross-license override bleed', () => {
    it('does not let a cancelled license grant seats through its stale override', async () => {
      // The exact production failure: a 300-seat base license is cancelled
      // mid-term while a +100 add-on stays live. The org now has ONE live
      // license, but listOverrides still returns BOTH overrides.
      const entitlements = await build({
        licenses: [
          license({
            id: 'lic-base',
            status: 'cancelled',
            created_at: PAST,
            cancelled_at: NEWER,
          }),
          license({ id: 'lic-addon', created_at: NEWER }),
        ],
        overrides: [
          override({
            id: 'o-base',
            organization_license_id: 'lic-base',
            feature_key: 'limit_users',
            entitlement_value: 300,
            created_at: PAST,
          }),
          override({
            id: 'o-addon',
            organization_license_id: 'lic-addon',
            feature_key: 'limit_users',
            entitlement_value: 100,
            created_at: NEWER,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBe(100);
      // Structural guarantee: the dead license is never even queried.
      expect(repository.listOverridesForLicenses).toHaveBeenCalledWith(ORG, [
        'lic-addon',
      ]);
    });

    it('does not let a cancelled license enable a module through its stale override', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-base', status: 'cancelled', created_at: PAST }),
          license({ id: 'lic-addon', created_at: NEWER }),
        ],
        overrides: [
          override({
            id: 'o-base',
            organization_license_id: 'lic-base',
            feature_key: 'module_wiki',
            entitlement_value: true,
            created_at: PAST,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.has('module_wiki')).toBe(false);
    });
  });

  describe('multiple live licenses', () => {
    it('sums limits and ORs booleans across overlapping licenses', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-base', created_at: PAST }),
          license({ id: 'lic-addon', plan_id: PLAN_ID_2, created_at: NEWER }),
        ],
        planFeatures: {
          [PLAN_ID]: [planFeature({ id: 'f-1', feature_key: 'module_tasks' })],
          [PLAN_ID_2]: [
            planFeature({
              id: 'f-2',
              plan_id: PLAN_ID_2,
              feature_key: 'module_wiki',
            }),
          ],
        },
        overrides: [
          override({
            id: 'o-base',
            organization_license_id: 'lic-base',
            feature_key: 'limit_users',
            entitlement_value: 200,
            created_at: PAST,
          }),
          override({
            id: 'o-addon',
            organization_license_id: 'lic-addon',
            feature_key: 'limit_users',
            entitlement_value: 100,
            created_at: NEWER,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBe(300);
      // A module granted by either license is enabled.
      expect(entitlements.has('module_tasks')).toBe(true);
      expect(entitlements.has('module_wiki')).toBe(true);
    });

    it('treats any unlimited grant as unlimited', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-a', created_at: PAST }),
          license({ id: 'lic-b', created_at: NEWER }),
        ],
        overrides: [
          override({
            id: 'o-a',
            organization_license_id: 'lic-a',
            feature_key: 'limit_users',
            entitlement_value: 100,
          }),
          override({
            id: 'o-b',
            organization_license_id: 'lic-b',
            feature_key: 'limit_users',
            entitlement_value: null,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBeNull();
    });

    it('reports the most severe status, not the newest', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-old', status: 'suspended', created_at: PAST }),
          license({ id: 'lic-new', status: 'active', created_at: NEWER }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.licenseStatus).toBe('suspended');
    });

    it('drops a license that is past its ends_at from the sum', async () => {
      const entitlements = await build({
        licenses: [
          license({ id: 'lic-live', created_at: PAST }),
          license({ id: 'lic-ended', ends_at: PAST, created_at: NEWER }),
        ],
        overrides: [
          override({
            id: 'o-live',
            organization_license_id: 'lic-live',
            feature_key: 'limit_users',
            entitlement_value: 100,
          }),
          override({
            id: 'o-ended',
            organization_license_id: 'lic-ended',
            feature_key: 'limit_users',
            entitlement_value: 900,
          }),
        ],
      }).getEffectiveEntitlements(ORG);

      expect(entitlements.getLimit('limit_users')).toBe(100);
    });
  });

  describe('caching', () => {
    it('resolves once per org within the TTL and re-resolves after bust()', async () => {
      const svc = build({ licenses: [license({ id: 'lic-1' })] });

      await svc.getEffectiveEntitlements(ORG);
      await svc.getEffectiveEntitlements(ORG);
      expect(repository.getLiveLicenses).toHaveBeenCalledTimes(1);
      expect(svc.stats()).toMatchObject({ hits: 1, misses: 1 });

      svc.bust(ORG);
      await svc.getEffectiveEntitlements(ORG);
      expect(repository.getLiveLicenses).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed resolution', async () => {
      const svc = build({ licenses: [] });
      repository.getLiveLicenses
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce([]);

      await expect(svc.getEffectiveEntitlements(ORG)).rejects.toThrow(
        'db down',
      );
      await expect(svc.getEffectiveEntitlements(ORG)).resolves.toMatchObject({
        grandfathered: true,
      });
    });
  });

  describe('toSnapshot', () => {
    it('enumerates the whole catalog as enabled for a grandfathered tenant', async () => {
      const entitlements = await build({
        licenses: [],
      }).getEffectiveEntitlements(ORG);
      const snapshot = EntitlementsService.toSnapshot(entitlements)!;

      expect(snapshot.grandfathered).toBe(true);
      expect(Object.values(snapshot.features).every(Boolean)).toBe(true);
      expect(snapshot.limits.limit_users).toBeNull();
      expect(snapshot.sources.limit_users).toBe('grandfathered');
    });

    it('returns null when there are no entitlements to flatten', () => {
      expect(EntitlementsService.toSnapshot(null)).toBeNull();
    });
  });
});
