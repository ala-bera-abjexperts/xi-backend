import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  LicenseChangeRequestStatus,
  LicenseChangeRequestType,
  LicenseFeatureType,
  LicensePlanStatus,
  OrganizationLicenseStatus,
} from './dto/licensing.dto';
import { LIVE_LICENSE_STATUSES } from './licensing.constants';

export interface LicensePlanRow {
  id: string;
  plan_key: string;
  name: string;
  description: string | null;
  status: LicensePlanStatus;
  billing_period: string;
  currency: string;
  price_cents: number;
  trial_days: number;
  included_seats: number | null;
  max_seats: number | null;
  limits: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LicenseFeatureRow {
  id: string;
  plan_id: string;
  feature_key: string;
  feature_name: string;
  description: string | null;
  feature_type: LicenseFeatureType;
  entitlement_value: unknown;
  is_metered: boolean;
  display_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrganizationLicenseRow {
  id: string;
  organization_id: string;
  plan_id: string;
  status: OrganizationLicenseStatus;
  seats_purchased: number;
  seats_used: number;
  starts_at: string;
  /**
   * Partner-sold licenses set an explicit window end (additive nullable column).
   * Optional so row literals built before the column existed still type-check;
   * the resolver treats `undefined` identically to `null` (`!lic.ends_at`).
   */
  ends_at?: string | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  suspension_reason: string | null;
  external_provider: string | null;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LicenseOverrideRow {
  id: string;
  organization_license_id: string;
  feature_key: string;
  entitlement_value: unknown;
  reason: string | null;
  expires_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Present only on rows returned by `listOverrides`, which joins
   * `organization_licenses!inner(id,organization_id)` so callers can filter by
   * tenant. Other read paths (e.g. `getOverrideByKey`) do NOT populate this.
   */
  organization_licenses?: { id: string; organization_id: string };
}

export interface LicenseUsageCounterRow {
  id: string;
  organization_id: string;
  organization_license_id: string | null;
  feature_key: string;
  period_start: string;
  period_end: string;
  quantity: number;
  hard_limit: number | null;
  unit: string;
  last_calculated_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LicenseChangeRequestRow {
  id: string;
  organization_id: string;
  /** Joined from organizations.name — present on list responses, null on single-row fetches. */
  organization_name?: string | null;
  current_license_id: string | null;
  requested_plan_id: string | null;
  requested_seats: number | null;
  request_type: LicenseChangeRequestType;
  status: LicenseChangeRequestStatus;
  request_note: string | null;
  review_note: string | null;
  requested_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LicenseAuditEventRow {
  id: string;
  organization_id: string | null;
  /** Joined from organizations.name — present on list responses, null on single-row fetches. */
  organization_name?: string | null;
  organization_license_id: string | null;
  actor_user_id: string | null;
  event_type: string;
  event_source: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface PageFilters {
  page?: number;
  pageSize?: number;
}

@Injectable()
export class LicensingRepository {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private page(filters: PageFilters) {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;
    return { from, to: from + pageSize - 1 };
  }

  private dbError(
    error: { message?: string } | null | undefined,
    fallback: string,
  ) {
    return new BadRequestException(error?.message ?? fallback);
  }

  async organizationExists(organizationId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('organizations')
      .select('id')
      .eq('id', organizationId)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to validate organization');
    return !!data;
  }

  async listPlans(filters: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: LicensePlanStatus;
    activeOnly?: boolean;
  }): Promise<{ data: LicensePlanRow[]; totalCount: number }> {
    const { from, to } = this.page(filters);

    let countQuery = this.client
      .from('license_plans')
      .select('id', { count: 'exact', head: true });
    let dataQuery = this.client.from('license_plans').select('*');

    if (filters.activeOnly) {
      countQuery = countQuery.eq('status', 'active');
      dataQuery = dataQuery.eq('status', 'active');
    } else if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
      dataQuery = dataQuery.eq('status', filters.status);
    }

    if (filters.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '').trim();
      if (safe.length > 0) {
        countQuery = countQuery.or(
          `name.ilike.%${safe}%,plan_key.ilike.%${safe}%`,
        );
        dataQuery = dataQuery.or(
          `name.ilike.%${safe}%,plan_key.ilike.%${safe}%`,
        );
      }
    }

    const countResult = await countQuery;
    if (countResult.error) {
      throw this.dbError(countResult.error, 'Failed to count license plans');
    }

    const { data, error } = await dataQuery
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw this.dbError(error, 'Failed to list license plans');

    return {
      data: (data ?? []) as LicensePlanRow[],
      totalCount: countResult.count ?? 0,
    };
  }

  async getPlanById(planId: string): Promise<LicensePlanRow | null> {
    const { data, error } = await this.client
      .from('license_plans')
      .select('*')
      .eq('id', planId)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load license plan');
    return (data as LicensePlanRow | null) ?? null;
  }

  async findPlanByKey(planKey: string): Promise<LicensePlanRow | null> {
    const { data, error } = await this.client
      .from('license_plans')
      .select('*')
      .eq('plan_key', planKey)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to check license plan key');
    return (data as LicensePlanRow | null) ?? null;
  }

  async createPlan(input: Record<string, unknown>): Promise<LicensePlanRow> {
    const { data, error } = await this.client
      .from('license_plans')
      .insert(input)
      .select()
      .single();

    if (error) throw this.dbError(error, 'Failed to create license plan');
    return data as LicensePlanRow;
  }

  async updatePlan(
    planId: string,
    patch: Record<string, unknown>,
  ): Promise<LicensePlanRow> {
    const { data, error } = await this.client
      .from('license_plans')
      .update(patch)
      .eq('id', planId)
      .select()
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to update license plan');
    if (!data) throw new NotFoundException('License plan not found');
    return data as LicensePlanRow;
  }

  async listPlanFeatures(planId: string): Promise<LicenseFeatureRow[]> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .select('*')
      .eq('plan_id', planId)
      .order('display_order', { ascending: true })
      .order('feature_name', { ascending: true });

    if (error) throw this.dbError(error, 'Failed to list plan features');
    return (data ?? []) as LicenseFeatureRow[];
  }

  async getPlanFeature(
    planId: string,
    featureId: string,
  ): Promise<LicenseFeatureRow | null> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .select('*')
      .eq('plan_id', planId)
      .eq('id', featureId)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load plan feature');
    return (data as LicenseFeatureRow | null) ?? null;
  }

  /**
   * Returns the organization_ids of every tenant currently on a live license
   * for the given plan. Used by `LicensingService.audit()` to cascade-bust the
   * entitlements cache when a plan-level mutation (createPlanFeature /
   * updatePlanFeature / deletePlanFeature) changes entitlements for every
   * tenant on that plan. Live = trialing/active/past_due/suspended; cancelled
   * and expired tenants don't need busting because their entitlements are
   * grandfathered at the resolver layer.
   */
  /**
   * Returns tenants with NO live license (`trialing`, `active`, `past_due`,
   * `suspended`). Includes tenants with cancelled/expired licenses AND tenants
   * with no `organization_licenses` row at all — both are effectively
   * grandfathered. Uses the `list_tenants_without_live_license()` RPC
   * (migration 20260528150000) which is SECURITY DEFINER granted to
   * `service_role` only.
   */
  async listTenantsWithoutLicense(): Promise<
    Array<{ id: string; name: string; slug: string; created_at: string }>
  > {
    const { data, error } = await this.client.rpc(
      'list_tenants_without_live_license',
    );

    if (error) {
      throw this.dbError(error, 'Failed to list tenants without license');
    }

    return (data ?? []) as Array<{
      id: string;
      name: string;
      slug: string;
      created_at: string;
    }>;
  }

  async findOrgIdsForPlan(planId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('organization_id')
      .eq('plan_id', planId)
      .in('status', LIVE_LICENSE_STATUSES);

    if (error) {
      throw this.dbError(error, 'Failed to look up tenants for plan');
    }

    const ids = (data ?? []).map(
      (row) => (row as { organization_id: string }).organization_id,
    );

    return Array.from(new Set(ids));
  }

  /**
   * Returns the distinct set of `feature_key`s present across ALL plans.
   * Used once at boot by EntitlementsService to WARN about feature keys that
   * exist in the database but are missing from the feature catalog. Not scoped
   * to a tenant — this is global catalog-reconciliation metadata, not tenant data.
   */
  async listDistinctPlanFeatureKeys(): Promise<string[]> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .select('feature_key');

    if (error) throw this.dbError(error, 'Failed to list plan feature keys');

    const keys = (data ?? []).map(
      (row) => (row as { feature_key: string }).feature_key,
    );

    return Array.from(new Set(keys));
  }

  async getPlanFeatureByKey(
    planId: string,
    featureKey: string,
  ): Promise<LicenseFeatureRow | null> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .select('*')
      .eq('plan_id', planId)
      .eq('feature_key', featureKey)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to check feature key');
    return (data as LicenseFeatureRow | null) ?? null;
  }

  async createPlanFeature(
    input: Record<string, unknown>,
  ): Promise<LicenseFeatureRow> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .insert(input)
      .select()
      .single();

    if (error) throw this.dbError(error, 'Failed to create plan feature');
    return data as LicenseFeatureRow;
  }

  async updatePlanFeature(
    planId: string,
    featureId: string,
    patch: Record<string, unknown>,
  ): Promise<LicenseFeatureRow> {
    const { data, error } = await this.client
      .from('license_plan_features')
      .update(patch)
      .eq('plan_id', planId)
      .eq('id', featureId)
      .select()
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to update plan feature');
    if (!data) throw new NotFoundException('Plan feature not found');
    return data as LicenseFeatureRow;
  }

  async deletePlanFeature(planId: string, featureId: string): Promise<void> {
    const { error } = await this.client
      .from('license_plan_features')
      .delete()
      .eq('plan_id', planId)
      .eq('id', featureId);

    if (error) throw this.dbError(error, 'Failed to delete plan feature');
  }

  /**
   * Transactional bulk-sync of plan features via the
   * `bulk_sync_plan_features_atomic` Supabase RPC (migration
   * 20260528120000). The RPC handles insert/update/delete reconciliation
   * atomically under a `FOR UPDATE` lock on the plan row.
   *
   * Named errors raised by the RPC (translated upstream by the service):
   *  - PLAN_NOT_FOUND
   *  - PAYLOAD_MUST_BE_ARRAY
   *  - DUPLICATE_KEY_IN_PAYLOAD
   *  - MISSING_FEATURE_KEY
   *  - CONFIRM_FULL_REPLACE_REQUIRED
   */
  async bulkSyncPlanFeaturesAtomic(
    planId: string,
    payload: Array<Record<string, unknown>>,
    catalogKeys: string[],
    preserveUnknownKeys: boolean,
    confirmFullReplace: boolean,
  ): Promise<{
    inserted_keys: string[];
    updated_keys: string[];
    deleted_keys: string[];
  }> {
    const { data, error } = await this.client.rpc(
      'bulk_sync_plan_features_atomic',
      {
        p_plan_id: planId,
        p_payload: payload,
        p_catalog_keys: catalogKeys,
        p_preserve_unknown_keys: preserveUnknownKeys,
        p_confirm_full_replace: confirmFullReplace,
      },
    );

    if (error) {
      // Surface the raw Postgres message verbatim; the service layer parses
      // its `code` / `message` prefix to translate into a typed exception.
      throw new BadRequestException(error.message ?? 'Bulk-sync failed');
    }

    const result = (data ?? {
      inserted_keys: [],
      updated_keys: [],
      deleted_keys: [],
    }) as {
      inserted_keys: string[] | null;
      updated_keys: string[] | null;
      deleted_keys: string[] | null;
    };

    return {
      inserted_keys: result.inserted_keys ?? [],
      updated_keys: result.updated_keys ?? [],
      deleted_keys: result.deleted_keys ?? [],
    };
  }

  async getLiveOrganizationLicense(
    organizationId: string,
  ): Promise<OrganizationLicenseRow | null> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*')
      .eq('organization_id', organizationId)
      .in('status', LIVE_LICENSE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load organization license');
    return (data as OrganizationLicenseRow | null) ?? null;
  }

  /**
   * All live licenses for an org (newest first), unbounded. Used by the
   * entitlements resolver, which aggregates across every license a tenant
   * holds (a base license plus any additional time-boxed ones). Status is
   * filtered here in SQL; the resolver applies the `starts_at`/`ends_at`
   * window on top.
   */
  async getLiveLicenses(
    organizationId: string,
  ): Promise<OrganizationLicenseRow[]> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*')
      .eq('organization_id', organizationId)
      .in('status', LIVE_LICENSE_STATUSES)
      .order('created_at', { ascending: false });

    if (error)
      throw this.dbError(error, 'Failed to load organization licenses');
    return (data as OrganizationLicenseRow[]) ?? [];
  }

  /**
   * The most recent NON-live license for an org (cancelled or expired), or null
   * when the org never had one.
   *
   * Exists because `getLiveLicenses` filters status in SQL, so the resolver can
   * never see the row it is supposed to report. Without this, a cancelled tenant
   * resolves as "no license at all" => grandfathered => unlimited, and
   * FeatureGuard's LICENSE_INACTIVE branch is unreachable. See
   * EntitlementsService.resolve().
   */
  async getLatestInactiveLicense(
    organizationId: string,
  ): Promise<OrganizationLicenseRow | null> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*')
      .eq('organization_id', organizationId)
      .in('status', ['cancelled', 'expired'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error)
      throw this.dbError(error, 'Failed to load inactive organization license');
    return (data as OrganizationLicenseRow | null) ?? null;
  }

  /**
   * Live licences whose window has closed: `ends_at` passed, or a trial ended
   * with no `ends_at`. Input for the daily status sweep.
   */
  async listLapsedLiveLicenses(
    nowIso: string,
  ): Promise<OrganizationLicenseRow[]> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*')
      .in('status', LIVE_LICENSE_STATUSES)
      .or(
        `ends_at.lt.${nowIso},and(status.eq.trialing,ends_at.is.null,trial_ends_at.lt.${nowIso})`,
      )
      .limit(500);

    if (error) throw this.dbError(error, 'Failed to list lapsed licenses');
    return (data as OrganizationLicenseRow[] | null) ?? [];
  }

  /** Seats in use: active members + pending invitations (each becomes a seat). */
  async countSeatsInUse(organizationId: string): Promise<number> {
    const [members, pending] = await Promise.all([
      // organization_members has no is_active column; an active member is a
      // membership whose user account is active (deactivated and imported
      // placeholder users hold no seat).
      this.client
        .from('organization_members')
        .select('id, users!inner(is_active)', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('users.is_active', true),
      this.client
        .from('invitations')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('status', 'pending'),
    ]);

    if (members.error)
      throw this.dbError(members.error, 'Failed to count members');
    if (pending.error)
      throw this.dbError(pending.error, 'Failed to count invitations');

    return (members.count ?? 0) + (pending.count ?? 0);
  }

  /**
   * True when the org predates `licensing_settings.grandfather_before`, i.e. it
   * may keep the unlimited "never licensed" posture. Orgs created after the
   * cutoff resolve to the Free tier instead.
   *
   * Fails OPEN to `true` when the settings row (or the org) is missing: an
   * absent cutoff must never silently downgrade every existing tenant.
   */
  async isCreatedBeforeGrandfatherCutoff(
    organizationId: string,
  ): Promise<boolean> {
    const [settings, org] = await Promise.all([
      this.client
        .from('licensing_settings')
        .select('grandfather_before')
        .eq('id', 1)
        .maybeSingle(),
      this.client
        .from('organizations')
        .select('created_at')
        .eq('id', organizationId)
        .maybeSingle(),
    ]);

    if (settings.error)
      throw this.dbError(settings.error, 'Failed to load licensing settings');
    if (org.error) throw this.dbError(org.error, 'Failed to load organization');

    const cutoff = (settings.data as { grandfather_before?: string } | null)
      ?.grandfather_before;
    const createdAt = (org.data as { created_at?: string } | null)?.created_at;

    if (!cutoff || !createdAt) return true;

    return new Date(createdAt).getTime() < new Date(cutoff).getTime();
  }

  /**
   * Total purchased seats across all live, in-window licenses for an org.
   * `ends_at` is null for pre-partner licenses, so they are always in-window.
   */
  async getTotalLiveSeats(organizationId: string): Promise<number> {
    const licenses = await this.getLiveLicenses(organizationId);
    const now = Date.now();

    return licenses
      .filter((lic) => !lic.ends_at || new Date(lic.ends_at).getTime() >= now)
      .reduce((sum, lic) => sum + (lic.seats_purchased ?? 0), 0);
  }

  /**
   * Every licence of an org, newest first, with its plan and (for partner-sold
   * licences) the partner's name. Capped: a tenant has a handful, not hundreds.
   */
  async listOrganizationLicenses(organizationId: string) {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*, license_plans(plan_key, name, status)')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error)
      throw this.dbError(error, 'Failed to list organization licenses');

    const rows = (data ?? []) as Array<
      OrganizationLicenseRow & {
        partner_id?: string | null;
        label?: string | null;
        license_plans?: {
          plan_key: string;
          name: string;
          status: string;
        } | null;
      }
    >;
    const partnerIds = [
      ...new Set(
        rows.map((r) => r.partner_id).filter((id): id is string => !!id),
      ),
    ];
    const partnerNames = new Map<string, string>();

    if (partnerIds.length > 0) {
      const partners = await this.client
        .from('organizations')
        .select('id, name')
        .in('id', partnerIds);
      if (partners.error)
        throw this.dbError(partners.error, 'Failed to load partner names');
      for (const p of (partners.data ?? []) as { id: string; name: string }[]) {
        partnerNames.set(p.id, p.name);
      }
    }

    return rows.map((r) => ({
      ...r,
      partner_name: r.partner_id
        ? (partnerNames.get(r.partner_id) ?? null)
        : null,
    }));
  }

  async getOrganizationLicenseById(
    organizationId: string,
    licenseId: string,
  ): Promise<OrganizationLicenseRow | null> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', licenseId)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load organization license');
    return (data as OrganizationLicenseRow | null) ?? null;
  }

  async createOrganizationLicense(
    input: Record<string, unknown>,
  ): Promise<OrganizationLicenseRow> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .insert(input)
      .select()
      .single();

    if (error)
      throw this.dbError(error, 'Failed to create organization license');
    return data as OrganizationLicenseRow;
  }

  async updateOrganizationLicense(
    organizationId: string,
    licenseId: string,
    patch: Record<string, unknown>,
  ): Promise<OrganizationLicenseRow> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', licenseId)
      .select()
      .maybeSingle();

    if (error)
      throw this.dbError(error, 'Failed to update organization license');
    if (!data) throw new NotFoundException('Organization license not found');
    return data as OrganizationLicenseRow;
  }

  /**
   * EVERY override an org holds, across all of its licenses regardless of the
   * license's status or window. This is the admin/management view (the SA
   * override table and `expandLicense`), which must keep showing overrides
   * attached to cancelled or not-yet-started licenses so they can be managed.
   *
   * NOT for entitlement resolution — a flat per-org override list cannot say
   * which license granted what, so merging it by feature_key lets a dead
   * license's override win. Resolvers must use `listOverridesForLicenses`.
   */
  async listOverrides(organizationId: string): Promise<LicenseOverrideRow[]> {
    const { data, error } = await this.client
      .from('organization_license_feature_overrides')
      .select('*, organization_licenses!inner(id,organization_id)')
      .eq('organization_licenses.organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw this.dbError(error, 'Failed to list license overrides');
    return (data ?? []) as LicenseOverrideRow[];
  }

  /**
   * Overrides belonging to an explicit set of licenses (newest first). The
   * entitlements resolver passes only the licenses it is actually aggregating,
   * so an override owned by a cancelled/expired/not-yet-started license can
   * never reach the merge — defence in depth behind the resolver's own
   * per-license grouping.
   *
   * Scoped by organization_id as well as license id: the service-role client
   * bypasses RLS, so tenant scoping is this layer's responsibility even though
   * the caller derives `licenseIds` from an org-scoped read.
   */
  async listOverridesForLicenses(
    organizationId: string,
    licenseIds: string[],
  ): Promise<LicenseOverrideRow[]> {
    if (licenseIds.length === 0) return [];

    const { data, error } = await this.client
      .from('organization_license_feature_overrides')
      .select('*, organization_licenses!inner(id,organization_id)')
      .eq('organization_licenses.organization_id', organizationId)
      .in('organization_license_id', licenseIds)
      .order('created_at', { ascending: false });

    if (error) throw this.dbError(error, 'Failed to list license overrides');
    return (data ?? []) as LicenseOverrideRow[];
  }

  async upsertOverride(
    input: Record<string, unknown>,
  ): Promise<LicenseOverrideRow> {
    const { data, error } = await this.client
      .from('organization_license_feature_overrides')
      .upsert(input, { onConflict: 'organization_license_id,feature_key' })
      .select()
      .single();

    if (error) throw this.dbError(error, 'Failed to save license override');
    return data as LicenseOverrideRow;
  }

  async getOverrideByKey(
    organizationLicenseId: string,
    featureKey: string,
  ): Promise<LicenseOverrideRow | null> {
    const { data, error } = await this.client
      .from('organization_license_feature_overrides')
      .select('*')
      .eq('organization_license_id', organizationLicenseId)
      .eq('feature_key', featureKey)
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load license override');
    return (data as LicenseOverrideRow | null) ?? null;
  }

  async deleteOverride(overrideId: string): Promise<void> {
    const { error } = await this.client
      .from('organization_license_feature_overrides')
      .delete()
      .eq('id', overrideId);

    if (error) throw this.dbError(error, 'Failed to delete license override');
  }

  async listUsageCounters(
    organizationId: string,
    filters: { organization_license_id?: string; feature_key?: string },
  ): Promise<LicenseUsageCounterRow[]> {
    // Cast numeric columns to float8 so PostgREST returns JS numbers instead
    // of strings. Postgres `numeric` is serialised as text by PostgREST by
    // default; without the cast, `quantity` and `hard_limit` arrive as strings
    // and any downstream arithmetic silently concatenates instead of adding.
    let query = this.client
      .from('organization_license_usage_counters')
      .select(
        'id, organization_id, organization_license_id, feature_key, period_start, period_end, quantity::float8, hard_limit::float8, unit, last_calculated_at, metadata, created_at, updated_at',
      )
      .eq('organization_id', organizationId);

    if (filters.organization_license_id) {
      query = query.eq(
        'organization_license_id',
        filters.organization_license_id,
      );
    }
    if (filters.feature_key) {
      query = query.eq('feature_key', filters.feature_key);
    }

    const { data, error } = await query
      .order('period_start', { ascending: false })
      .order('feature_key', { ascending: true });

    if (error) throw this.dbError(error, 'Failed to list usage counters');
    return (data ?? []) as LicenseUsageCounterRow[];
  }

  async upsertUsageCounter(
    input: Record<string, unknown>,
  ): Promise<LicenseUsageCounterRow> {
    const { data, error } = await this.client
      .from('organization_license_usage_counters')
      .upsert(input, {
        onConflict: 'organization_id,feature_key,period_start,period_end',
      })
      .select(
        'id, organization_id, organization_license_id, feature_key, period_start, period_end, quantity::float8, hard_limit::float8, unit, last_calculated_at, metadata, created_at, updated_at',
      )
      .single();

    if (error) throw this.dbError(error, 'Failed to save usage counter');
    return data as LicenseUsageCounterRow;
  }

  async listChangeRequests(filters: {
    page?: number;
    pageSize?: number;
    organization_id?: string;
    status?: LicenseChangeRequestStatus;
  }): Promise<{ data: LicenseChangeRequestRow[]; totalCount: number }> {
    const { from, to } = this.page(filters);

    let countQuery = this.client
      .from('organization_license_change_requests')
      .select('id', { count: 'exact', head: true });
    let dataQuery = this.client
      .from('organization_license_change_requests')
      .select('*, organizations(name)');

    if (filters.organization_id) {
      countQuery = countQuery.eq('organization_id', filters.organization_id);
      dataQuery = dataQuery.eq('organization_id', filters.organization_id);
    }
    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
      dataQuery = dataQuery.eq('status', filters.status);
    }

    const countResult = await countQuery;
    if (countResult.error) {
      throw this.dbError(countResult.error, 'Failed to count change requests');
    }

    const { data, error } = await dataQuery
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw this.dbError(error, 'Failed to list change requests');

    const rows = (data ?? []).map((row: any) => ({
      ...row,
      organization_name: row.organizations?.name ?? null,
      organizations: undefined,
    })) as LicenseChangeRequestRow[];

    return { data: rows, totalCount: countResult.count ?? 0 };
  }

  async getChangeRequest(
    requestId: string,
    organizationId?: string,
  ): Promise<LicenseChangeRequestRow | null> {
    let query = this.client
      .from('organization_license_change_requests')
      .select('*')
      .eq('id', requestId);

    if (organizationId) query = query.eq('organization_id', organizationId);

    const { data, error } = await query.maybeSingle();

    if (error) throw this.dbError(error, 'Failed to load change request');
    return (data as LicenseChangeRequestRow | null) ?? null;
  }

  async createChangeRequest(
    input: Record<string, unknown>,
  ): Promise<LicenseChangeRequestRow> {
    const { data, error } = await this.client
      .from('organization_license_change_requests')
      .insert(input)
      .select()
      .single();

    if (error) throw this.dbError(error, 'Failed to create change request');
    return data as LicenseChangeRequestRow;
  }

  async updateChangeRequest(
    requestId: string,
    patch: Record<string, unknown>,
  ): Promise<LicenseChangeRequestRow> {
    const { data, error } = await this.client
      .from('organization_license_change_requests')
      .update(patch)
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (error) throw this.dbError(error, 'Failed to update change request');
    if (!data) throw new NotFoundException('Change request not found');
    return data as LicenseChangeRequestRow;
  }

  async createAuditEvent(
    input: Record<string, unknown>,
  ): Promise<LicenseAuditEventRow> {
    const { data, error } = await this.client
      .from('license_audit_events')
      .insert(input)
      .select()
      .single();

    if (error)
      throw this.dbError(error, 'Failed to create license audit event');
    return data as LicenseAuditEventRow;
  }

  async listAuditEvents(filters: {
    page?: number;
    pageSize?: number;
    organization_id?: string;
    organization_license_id?: string;
    event_type?: string;
  }): Promise<{ data: LicenseAuditEventRow[]; totalCount: number }> {
    const { from, to } = this.page(filters);

    let countQuery = this.client
      .from('license_audit_events')
      .select('id', { count: 'exact', head: true });
    let dataQuery = this.client
      .from('license_audit_events')
      .select('*, organizations(name)');

    if (filters.organization_id) {
      countQuery = countQuery.eq('organization_id', filters.organization_id);
      dataQuery = dataQuery.eq('organization_id', filters.organization_id);
    }
    if (filters.organization_license_id) {
      countQuery = countQuery.eq(
        'organization_license_id',
        filters.organization_license_id,
      );
      dataQuery = dataQuery.eq(
        'organization_license_id',
        filters.organization_license_id,
      );
    }
    if (filters.event_type) {
      countQuery = countQuery.eq('event_type', filters.event_type);
      dataQuery = dataQuery.eq('event_type', filters.event_type);
    }

    const countResult = await countQuery;
    if (countResult.error) {
      throw this.dbError(countResult.error, 'Failed to count audit events');
    }

    const { data, error } = await dataQuery
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw this.dbError(error, 'Failed to list audit events');

    const rows = (data ?? []).map((row: any) => ({
      ...row,
      organization_name: row.organizations?.name ?? null,
      organizations: undefined,
    })) as LicenseAuditEventRow[];

    return { data: rows, totalCount: countResult.count ?? 0 };
  }
}
