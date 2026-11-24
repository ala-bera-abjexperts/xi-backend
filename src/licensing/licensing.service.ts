import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  BulkSyncPlanFeatureItemDto,
  BulkSyncPlanFeaturesDto,
  CreateLicenseChangeRequestDto,
  CreateLicenseFeatureDto,
  CreateLicensePlanDto,
  ListChangeRequestsQueryDto,
  ListLicenseAuditEventsQueryDto,
  ListLicensePlansQueryDto,
  ListUsageCountersQueryDto,
  ReviewLicenseChangeRequestDto,
  UpdateLicenseFeatureDto,
  UpdateLicensePlanDto,
  UpdateOrganizationLicenseDto,
  UpsertLicenseFeatureOverrideDto,
  UpsertOrganizationLicenseDto,
  UpsertUsageCounterDto,
} from './dto/licensing.dto';
import type { OrganizationLicenseStatus } from './dto/licensing.dto';
import { EntitlementsService } from './entitlements.service';
import { FEATURE_CATALOG } from './feature-catalog';
import {
  LicenseChangeRequestRow,
  LicenseFeatureRow,
  LicensePlanRow,
  LicensingRepository,
  OrganizationLicenseRow,
} from './licensing.repository';
import { LIVE_LICENSE_STATUSES } from './licensing.constants';

@Injectable()
export class LicensingService {
  private readonly logger = new Logger(LicensingService.name);

  constructor(
    private readonly repository: LicensingRepository,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  listPlans(query: ListLicensePlansQueryDto, activeOnly = false) {
    return this.repository.listPlans({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      status: query.status,
      activeOnly,
    });
  }

  async getPlan(planId: string) {
    const plan = await this.requirePlan(planId);
    const features = await this.repository.listPlanFeatures(planId);
    return { ...plan, features };
  }

  async createPlan(
    dto: CreateLicensePlanDto,
    actor: RequestUser,
  ): Promise<LicensePlanRow> {
    const input = this.clean({
      ...dto,
      plan_key: dto.plan_key.trim().toLowerCase(),
      created_by: actor.userId,
      updated_by: actor.userId,
    });

    const existing = await this.repository.findPlanByKey(
      input.plan_key as string,
    );
    if (existing) {
      throw new ConflictException(
        'A license plan with this key already exists',
      );
    }

    this.assertSeatBounds(input);

    const plan = await this.repository.createPlan(input);
    await this.audit({
      actorUserId: actor.userId,
      eventType: 'license_plan_created',
      after: plan,
    });
    return plan;
  }

  async updatePlan(
    planId: string,
    dto: UpdateLicensePlanDto,
    actor: RequestUser,
  ): Promise<LicensePlanRow> {
    const existing = await this.requirePlan(planId);
    const patch = this.clean({
      ...dto,
      plan_key: dto.plan_key?.trim().toLowerCase(),
      updated_by: actor.userId,
    });

    if (patch.plan_key && patch.plan_key !== existing.plan_key) {
      const duplicate = await this.repository.findPlanByKey(
        patch.plan_key as string,
      );
      if (duplicate && duplicate.id !== planId) {
        throw new ConflictException(
          'A license plan with this key already exists',
        );
      }
    }

    this.assertSeatBounds({ ...existing, ...patch });

    const updated = await this.repository.updatePlan(planId, patch);
    await this.audit({
      actorUserId: actor.userId,
      eventType: 'license_plan_updated',
      before: existing,
      after: updated,
    });
    return updated;
  }

  async archivePlan(
    planId: string,
    actor: RequestUser,
  ): Promise<LicensePlanRow> {
    const existing = await this.requirePlan(planId);
    const updated = await this.repository.updatePlan(planId, {
      status: 'archived',
      updated_by: actor.userId,
    });
    await this.audit({
      actorUserId: actor.userId,
      eventType: 'license_plan_archived',
      before: existing,
      after: updated,
    });
    return updated;
  }

  async listPlanFeatures(planId: string): Promise<LicenseFeatureRow[]> {
    await this.requirePlan(planId);
    return this.repository.listPlanFeatures(planId);
  }

  async createPlanFeature(
    planId: string,
    dto: CreateLicenseFeatureDto,
    actor: RequestUser,
  ) {
    await this.requirePlan(planId);
    const featureKey = dto.feature_key.trim().toLowerCase();
    const duplicate = await this.repository.getPlanFeatureByKey(
      planId,
      featureKey,
    );
    if (duplicate) {
      throw new ConflictException(
        'A feature with this key already exists on this plan',
      );
    }

    const created = await this.repository.createPlanFeature(
      this.clean({
        ...dto,
        feature_key: featureKey,
        plan_id: planId,
      }),
    );
    await this.audit({
      planId,
      actorUserId: actor.userId,
      eventType: 'license_plan_feature_created',
      after: created,
    });
    return created;
  }

  async updatePlanFeature(
    planId: string,
    featureId: string,
    dto: UpdateLicenseFeatureDto,
    actor: RequestUser,
  ) {
    const existing = await this.requirePlanFeature(planId, featureId);
    const patch = this.clean({
      ...dto,
      feature_key: dto.feature_key?.trim().toLowerCase(),
    });

    if (patch.feature_key && patch.feature_key !== existing.feature_key) {
      const duplicate = await this.repository.getPlanFeatureByKey(
        planId,
        patch.feature_key as string,
      );
      if (duplicate && duplicate.id !== featureId) {
        throw new ConflictException(
          'A feature with this key already exists on this plan',
        );
      }
    }

    const updated = await this.repository.updatePlanFeature(
      planId,
      featureId,
      patch,
    );
    await this.audit({
      planId,
      actorUserId: actor.userId,
      eventType: 'license_plan_feature_updated',
      before: existing,
      after: updated,
    });
    return updated;
  }

  async deletePlanFeature(
    planId: string,
    featureId: string,
    actor: RequestUser,
  ) {
    const existing = await this.requirePlanFeature(planId, featureId);
    await this.repository.deletePlanFeature(planId, featureId);
    await this.audit({
      planId,
      actorUserId: actor.userId,
      eventType: 'license_plan_feature_deleted',
      before: existing,
    });
    return { success: true, message: 'License feature deleted' };
  }

  /**
   * Transactional bulk-sync of plan features. Delegates to the
   * `bulk_sync_plan_features_atomic` Supabase RPC; emits ONE consolidated
   * audit event with the full diff. Used by the SA catalog picker.
   *
   * Defenses:
   *  - `module_spaces` is force-included regardless of payload (it is "Always on")
   *  - Payload keys are deduped + lowercased (DB also enforces, this just produces
   *    a friendlier error)
   *  - The catalog_keys array is constructed from FEATURE_CATALOG at call time, so
   *    the RPC's preserve/delete logic always matches the current FE/BE catalog
   *
   * Translates RPC named exceptions → typed Nest exceptions so the frontend
   * can branch on `code`.
   */
  async bulkSyncPlanFeatures(
    planId: string,
    dto: BulkSyncPlanFeaturesDto,
    actor: RequestUser,
  ) {
    await this.requirePlan(planId);

    // Dedup + lowercase keys defensively.
    const desiredByKey = new Map<string, BulkSyncPlanFeatureItemDto>();
    for (const item of dto.features ?? []) {
      const key = item.feature_key.trim().toLowerCase();
      if (desiredByKey.has(key)) {
        throw new BadRequestException({
          code: 'DUPLICATE_KEY_IN_PAYLOAD',
          message: `Duplicate feature_key in payload: ${key}`,
        });
      }
      desiredByKey.set(key, { ...item, feature_key: key });
    }

    // Defense: module_spaces is Always-On. If the UI forgot to include it,
    // re-inject with the catalog default before sending to the RPC.
    if (!desiredByKey.has('module_spaces')) {
      const spaces = FEATURE_CATALOG.find((f) => f.key === 'module_spaces');
      if (spaces) {
        desiredByKey.set('module_spaces', {
          feature_key: spaces.key,
          feature_name: spaces.name,
          description: spaces.description,
          feature_type: spaces.type,
          entitlement_value: true,
          is_metered: false,
          display_order: 0,
          metadata: {},
        });
      }
    }

    const payload = Array.from(desiredByKey.values()).map((item) => ({
      feature_key: item.feature_key,
      feature_name: item.feature_name,
      description: item.description ?? null,
      feature_type: item.feature_type,
      entitlement_value: item.entitlement_value,
      is_metered: item.is_metered ?? false,
      display_order: item.display_order ?? 0,
      metadata: item.metadata ?? {},
    }));

    const catalogKeys = FEATURE_CATALOG.map((f) => f.key);
    const preserveUnknownKeys = dto.preserve_unknown_keys ?? true;
    const confirmFullReplace = dto.confirm_full_replace ?? false;

    let result: {
      inserted_keys: string[];
      updated_keys: string[];
      deleted_keys: string[];
    };
    try {
      result = await this.repository.bulkSyncPlanFeaturesAtomic(
        planId,
        payload,
        catalogKeys,
        preserveUnknownKeys,
        confirmFullReplace,
      );
    } catch (err) {
      // The repository wraps the raw Postgres message as a BadRequestException.
      // Extract the named code and re-throw a structured exception.
      const message =
        err instanceof Error
          ? err.message
          : String((err as { message?: unknown })?.message ?? err);

      if (message.startsWith('PLAN_NOT_FOUND')) {
        throw new NotFoundException('License plan not found');
      }
      if (message.startsWith('CONFIRM_FULL_REPLACE_REQUIRED')) {
        // The RPC RAISE appends the keys as `CONFIRM_FULL_REPLACE_REQUIRED: {key1,key2}`.
        const keyMatch = message.match(/\{([^}]*)\}/);
        const wouldDelete = keyMatch
          ? keyMatch[1]
              .split(',')
              .map((k) => k.trim())
              .filter((k) => k.length > 0)
          : [];
        throw new BadRequestException({
          code: 'CONFIRM_FULL_REPLACE_REQUIRED',
          message: `Full-replace would delete ${wouldDelete.length} feature row(s). Pass confirm_full_replace: true to proceed.`,
          would_delete_keys: wouldDelete,
        });
      }
      if (message.startsWith('DUPLICATE_KEY_IN_PAYLOAD')) {
        throw new BadRequestException({
          code: 'DUPLICATE_KEY_IN_PAYLOAD',
          message,
        });
      }
      if (message.startsWith('MISSING_FEATURE_KEY')) {
        throw new BadRequestException({
          code: 'MISSING_FEATURE_KEY',
          message: 'Every payload item must include a non-empty feature_key',
        });
      }
      if (message.startsWith('PAYLOAD_MUST_BE_ARRAY')) {
        throw new BadRequestException({
          code: 'PAYLOAD_MUST_BE_ARRAY',
          message,
        });
      }
      throw err;
    }

    const inserted_count = result.inserted_keys.length;
    const updated_count = result.updated_keys.length;
    const deleted_count = result.deleted_keys.length;

    // Short-circuit: no changes → no audit, no cascade bust (saves work).
    if (inserted_count + updated_count + deleted_count === 0) {
      const features = await this.repository.listPlanFeatures(planId);
      return {
        features,
        summary: {
          inserted_count: 0,
          updated_count: 0,
          deleted_count: 0,
          inserted_keys: [],
          updated_keys: [],
          deleted_keys: [],
        },
      };
    }

    // Single consolidated audit event. `planId` triggers cascade-bust for every
    // tenant on a live license for this plan (see audit() at the bottom of
    // this file — already wired in Phase 1).
    await this.audit({
      planId,
      actorUserId: actor.userId,
      eventType: 'license_plan_features_bulk_synced',
      after: {
        plan_id: planId,
        inserted_count,
        updated_count,
        deleted_count,
        inserted_keys: result.inserted_keys,
        updated_keys: result.updated_keys,
        deleted_keys: result.deleted_keys,
      },
    });

    const features = await this.repository.listPlanFeatures(planId);
    return {
      features,
      summary: {
        inserted_count,
        updated_count,
        deleted_count,
        inserted_keys: result.inserted_keys,
        updated_keys: result.updated_keys,
        deleted_keys: result.deleted_keys,
      },
    };
  }

  async getCurrentLicense(organizationId: string) {
    await this.requireOrganization(organizationId);
    const license =
      await this.repository.getLiveOrganizationLicense(organizationId);
    if (!license) return null;
    return this.expandLicense(license);
  }

  async upsertOrganizationLicense(
    organizationId: string,
    dto: UpsertOrganizationLicenseDto,
    actor: RequestUser,
  ) {
    await this.requireOrganization(organizationId);
    const plan = await this.requireAssignablePlan(dto.plan_id);
    const existing =
      await this.repository.getLiveOrganizationLicense(organizationId);

    const seatsPurchased =
      dto.seats_purchased ??
      existing?.seats_purchased ??
      plan.included_seats ??
      1;
    const seatsUsed = dto.seats_used ?? existing?.seats_used ?? 0;
    this.assertSeats(seatsPurchased, seatsUsed);
    this.assertWindow(
      dto.starts_at ?? existing?.starts_at ?? null,
      dto.ends_at !== undefined ? dto.ends_at : (existing?.ends_at ?? null),
    );

    const patch = this.normalizeLicensePatch({
      ...dto,
      status: dto.status ?? 'active',
      seats_purchased: seatsPurchased,
      seats_used: seatsUsed,
      organization_id: organizationId,
      updated_by: actor.userId,
    });

    let license: OrganizationLicenseRow;
    if (existing) {
      license = await this.repository.updateOrganizationLicense(
        organizationId,
        existing.id,
        patch,
      );
    } else {
      license = await this.repository.createOrganizationLicense({
        ...patch,
        created_by: actor.userId,
      });
    }

    await this.audit({
      organizationId,
      licenseId: license.id,
      actorUserId: actor.userId,
      eventType: existing
        ? 'organization_license_updated'
        : 'organization_license_created',
      before: existing,
      after: license,
    });
    return this.expandLicense(license);
  }

  async updateOrganizationLicense(
    organizationId: string,
    dto: UpdateOrganizationLicenseDto,
    actor: RequestUser,
  ) {
    const existing = await this.requireLiveLicense(organizationId);

    return this.applyLicenseUpdate(organizationId, existing, dto, actor);
  }

  /**
   * Updates ONE specific licence (any status). A tenant can hold several
   * stacked partner licences, and a cancelled one must be reachable to be
   * reactivated; the "current licence" endpoint only ever saw the newest live.
   */
  async updateOrganizationLicenseById(
    organizationId: string,
    licenseId: string,
    dto: UpdateOrganizationLicenseDto,
    actor: RequestUser,
  ) {
    const existing = await this.repository.getOrganizationLicenseById(
      organizationId,
      licenseId,
    );
    if (!existing) throw new NotFoundException('License not found');

    return this.applyLicenseUpdate(organizationId, existing, dto, actor);
  }

  /**
   * Every licence a tenant holds (newest first, live and ended) plus how the
   * tenant resolves overall, for the super-admin licence overview.
   */
  async listTenantLicenses(organizationId: string) {
    await this.requireOrganization(organizationId);

    const [licenses, entitlements, seatsInUse, beforeCutoff] =
      await Promise.all([
        this.repository.listOrganizationLicenses(organizationId),
        this.entitlementsService.getEffectiveEntitlements(organizationId),
        this.repository.countSeatsInUse(organizationId),
        this.repository.isCreatedBeforeGrandfatherCutoff(organizationId),
      ]);

    const now = Date.now();
    const posture = entitlements.grandfathered
      ? 'grandfathered'
      : licenses.length === 0
        ? beforeCutoff
          ? 'grandfathered'
          : 'free_default'
        : entitlements.licenseStatus === 'cancelled' ||
            entitlements.licenseStatus === 'expired'
          ? 'free_lapsed'
          : 'licensed';

    return {
      posture,
      license_status: entitlements.licenseStatus,
      seats_in_use: seatsInUse,
      seat_limit: entitlements.getLimit('limit_users'),
      licenses: licenses.map((lic) => ({
        ...lic,
        in_window:
          LIVE_LICENSE_STATUSES.includes(lic.status) &&
          new Date(lic.starts_at).getTime() <= now &&
          (!lic.ends_at || new Date(lic.ends_at).getTime() >= now),
      })),
    };
  }

  private async applyLicenseUpdate(
    organizationId: string,
    existing: OrganizationLicenseRow,
    dto: UpdateOrganizationLicenseDto,
    actor: RequestUser,
  ) {
    const mergedSeatsPurchased =
      dto.seats_purchased ?? existing.seats_purchased;
    const mergedSeatsUsed = dto.seats_used ?? existing.seats_used;
    this.assertSeats(mergedSeatsPurchased, mergedSeatsUsed);
    this.assertWindow(
      dto.starts_at ?? existing.starts_at,
      dto.ends_at !== undefined ? dto.ends_at : (existing.ends_at ?? null),
    );

    // Only a plan CHANGE must target an active plan. Partner licences sit on the
    // archived `partner_custom` plan; re-sending that unchanged plan_id while
    // editing status/dates must not fail "Only active license plans…".
    if (dto.plan_id && dto.plan_id !== existing.plan_id) {
      await this.requireAssignablePlan(dto.plan_id);
    }

    const updated = await this.repository.updateOrganizationLicense(
      organizationId,
      existing.id,
      this.normalizeLicensePatch({
        ...dto,
        updated_by: actor.userId,
      }),
    );

    await this.audit({
      organizationId,
      licenseId: updated.id,
      actorUserId: actor.userId,
      eventType: 'organization_license_updated',
      before: existing,
      after: updated,
    });
    return this.expandLicense(updated);
  }

  /**
   * Phase 5 — Super Admin visibility: returns every tenant that has NO live
   * license. Includes grandfathered (no row) AND cancelled/expired tenants.
   * Used by `GET /admin/licensing/tenants-without-license`. Read-only — no
   * audit emit needed.
   */
  listTenantsWithoutLicense() {
    return this.repository.listTenantsWithoutLicense();
  }

  /**
   * Phase 6 — SA debug endpoint: resolve a tenant's effective entitlements.
   * When `busted=true`, invalidate the per-org cache first to force a fresh
   * DB read. Returns the JSON-serializable snapshot + current cache stats.
   *
   * SA-only; do NOT expose to tenants.
   */
  async debugEntitlements(
    organizationId: string,
    options: { busted?: boolean } = {},
  ) {
    if (options.busted) this.entitlementsService.bust(organizationId);
    const entitlements =
      await this.entitlementsService.getEffectiveEntitlements(organizationId);

    return {
      snapshot: EntitlementsService.toSnapshot(entitlements),
      cache_stats: this.entitlementsService.stats(),
    };
  }

  /**
   * Phase 6 — SA debug endpoint: resolver cache stats.
   * `hit_ratio` is `hits / (hits + misses)`. Returns 0 when no resolves have
   * happened yet (divide-by-zero guard).
   */
  getCacheStats() {
    const stats = this.entitlementsService.stats();
    const total = stats.hits + stats.misses;

    return {
      ...stats,
      hit_ratio: total === 0 ? 0 : stats.hits / total,
    };
  }

  listOverrides(organizationId: string) {
    return this.repository.listOverrides(organizationId);
  }

  async upsertOverride(
    organizationId: string,
    dto: UpsertLicenseFeatureOverrideDto,
    actor: RequestUser,
  ) {
    const license = await this.repository.getOrganizationLicenseById(
      organizationId,
      dto.organization_license_id,
    );
    if (!license) throw new NotFoundException('Organization license not found');

    const override = await this.repository.upsertOverride(
      this.clean({
        ...dto,
        feature_key: dto.feature_key.trim().toLowerCase(),
        created_by: actor.userId,
        updated_by: actor.userId,
      }),
    );

    await this.audit({
      organizationId,
      licenseId: dto.organization_license_id,
      actorUserId: actor.userId,
      eventType: 'license_feature_override_upserted',
      after: override,
    });
    return override;
  }

  async deleteOverride(
    organizationId: string,
    featureKey: string,
    actor: RequestUser,
  ) {
    await this.requireOrganization(organizationId);

    const normalizedKey = featureKey.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(normalizedKey)) {
      throw new BadRequestException(
        'feature_key must be a valid snake_case key',
      );
    }

    const license =
      await this.repository.getLiveOrganizationLicense(organizationId);
    if (!license) throw new NotFoundException('Organization license not found');

    const override = await this.repository.getOverrideByKey(
      license.id,
      normalizedKey,
    );
    if (!override) throw new NotFoundException('Override not found');

    await this.repository.deleteOverride(override.id);

    await this.audit({
      organizationId,
      licenseId: license.id,
      actorUserId: actor.userId,
      eventType: 'license_feature_override_deleted',
      before: override,
    });

    return { success: true, message: 'Override deleted' };
  }

  async getTenantEntitlements(organizationId: string) {
    await this.requireOrganization(organizationId);
    const entitlements =
      await this.entitlementsService.getEffectiveEntitlements(organizationId);

    return EntitlementsService.toSnapshot(entitlements);
  }

  listUsage(organizationId: string, query: ListUsageCountersQueryDto) {
    return this.repository.listUsageCounters(organizationId, query);
  }

  async upsertUsage(
    organizationId: string,
    dto: UpsertUsageCounterDto,
    actor: RequestUser,
  ) {
    if (new Date(dto.period_end) <= new Date(dto.period_start)) {
      throw new BadRequestException('period_end must be after period_start');
    }

    if (dto.organization_license_id) {
      const license = await this.repository.getOrganizationLicenseById(
        organizationId,
        dto.organization_license_id,
      );
      if (!license)
        throw new NotFoundException('Organization license not found');
    }

    const counter = await this.repository.upsertUsageCounter(
      this.clean({
        ...dto,
        feature_key: dto.feature_key.trim().toLowerCase(),
        organization_id: organizationId,
      }),
    );

    await this.audit({
      organizationId,
      licenseId: dto.organization_license_id ?? null,
      actorUserId: actor.userId,
      eventType: 'license_usage_counter_upserted',
      after: counter,
    });
    return counter;
  }

  listChangeRequests(query: ListChangeRequestsQueryDto) {
    return this.repository.listChangeRequests(query);
  }

  listTenantChangeRequests(
    organizationId: string,
    query: ListChangeRequestsQueryDto,
  ) {
    return this.repository.listChangeRequests({
      ...query,
      organization_id: organizationId,
    });
  }

  async createTenantChangeRequest(
    organizationId: string,
    dto: CreateLicenseChangeRequestDto,
    actor: RequestUser,
  ) {
    const liveLicense =
      await this.repository.getLiveOrganizationLicense(organizationId);
    const currentLicenseId = dto.current_license_id ?? liveLicense?.id ?? null;

    if (dto.current_license_id) {
      const scoped = await this.repository.getOrganizationLicenseById(
        organizationId,
        dto.current_license_id,
      );
      if (!scoped) throw new NotFoundException('Current license not found');
    }

    if (
      dto.request_type === 'new_license' ||
      dto.request_type === 'plan_change'
    ) {
      if (!dto.requested_plan_id) {
        throw new BadRequestException('requested_plan_id is required');
      }
      await this.requireAssignablePlan(dto.requested_plan_id);
    }

    if (dto.request_type === 'seat_change' && dto.requested_seats == null) {
      throw new BadRequestException('requested_seats is required');
    }

    if (
      ['seat_change', 'cancel', 'reactivate'].includes(dto.request_type) &&
      !currentLicenseId
    ) {
      throw new BadRequestException(
        'A current license is required for this request',
      );
    }

    const request = await this.repository.createChangeRequest(
      this.clean({
        organization_id: organizationId,
        current_license_id: currentLicenseId,
        requested_plan_id: dto.requested_plan_id ?? null,
        requested_seats: dto.requested_seats ?? null,
        request_type: dto.request_type,
        request_note: dto.request_note ?? null,
        metadata: dto.metadata ?? {},
        requested_by: actor.userId,
        status: 'pending',
      }),
    );

    await this.audit({
      organizationId,
      licenseId: currentLicenseId,
      actorUserId: actor.userId,
      eventType: 'license_change_request_created',
      eventSource: 'owner_panel',
      after: request,
    });
    return request;
  }

  async cancelTenantChangeRequest(
    organizationId: string,
    requestId: string,
    actor: RequestUser,
  ) {
    const request = await this.requireChangeRequest(requestId, organizationId);
    if (request.status !== 'pending') {
      throw new BadRequestException(
        'Only pending change requests can be cancelled',
      );
    }

    const updated = await this.repository.updateChangeRequest(requestId, {
      status: 'cancelled',
    });

    await this.audit({
      organizationId,
      licenseId: request.current_license_id,
      actorUserId: actor.userId,
      eventType: 'license_change_request_cancelled',
      eventSource: 'owner_panel',
      before: request,
      after: updated,
    });
    return updated;
  }

  async reviewChangeRequest(
    requestId: string,
    dto: ReviewLicenseChangeRequestDto,
    actor: RequestUser,
  ) {
    const request = await this.requireChangeRequest(requestId);
    if (request.status !== 'pending') {
      throw new BadRequestException(
        'Only pending change requests can be reviewed',
      );
    }

    let reviewed = await this.repository.updateChangeRequest(requestId, {
      status: dto.status,
      review_note: dto.review_note ?? null,
      reviewed_by: actor.userId,
      reviewed_at: new Date().toISOString(),
    });

    if (dto.status === 'approved') {
      const license = await this.applyApprovedChangeRequest(request, actor);
      reviewed = await this.repository.updateChangeRequest(requestId, {
        status: 'approved',
        current_license_id: license.id,
        review_note: dto.review_note ?? null,
        reviewed_by: actor.userId,
        reviewed_at: new Date().toISOString(),
      });
    }

    await this.audit({
      organizationId: request.organization_id,
      licenseId: reviewed.current_license_id,
      actorUserId: actor.userId,
      eventType:
        dto.status === 'approved'
          ? 'license_change_request_approved'
          : 'license_change_request_rejected',
      before: request,
      after: reviewed,
    });
    return reviewed;
  }

  listAuditEvents(query: ListLicenseAuditEventsQueryDto) {
    return this.repository.listAuditEvents(query);
  }

  private async applyApprovedChangeRequest(
    request: LicenseChangeRequestRow,
    actor: RequestUser,
  ): Promise<OrganizationLicenseRow> {
    const current = request.current_license_id
      ? await this.repository.getOrganizationLicenseById(
          request.organization_id,
          request.current_license_id,
        )
      : await this.repository.getLiveOrganizationLicense(
          request.organization_id,
        );

    if (
      ['cancel', 'reactivate', 'seat_change'].includes(request.request_type) &&
      !current
    ) {
      throw new BadRequestException(
        'A current license is required for this request',
      );
    }

    if (request.request_type === 'cancel') {
      return this.repository.updateOrganizationLicense(
        request.organization_id,
        current!.id,
        {
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_by: actor.userId,
        },
      );
    }

    if (request.request_type === 'reactivate') {
      return this.repository.updateOrganizationLicense(
        request.organization_id,
        current!.id,
        {
          status: 'active',
          cancelled_at: null,
          updated_by: actor.userId,
        },
      );
    }

    const planId = request.requested_plan_id ?? current?.plan_id;
    if (!planId) throw new BadRequestException('requested_plan_id is required');
    const plan = await this.requireAssignablePlan(planId);

    const seatsPurchased =
      request.requested_seats ??
      current?.seats_purchased ??
      plan.included_seats ??
      1;
    const seatsUsed = current?.seats_used ?? 0;
    this.assertSeats(seatsPurchased, seatsUsed);

    if (current) {
      return this.repository.updateOrganizationLicense(
        request.organization_id,
        current.id,
        {
          plan_id: planId,
          status: 'active',
          seats_purchased: seatsPurchased,
          cancelled_at: null,
          updated_by: actor.userId,
        },
      );
    }

    return this.repository.createOrganizationLicense({
      organization_id: request.organization_id,
      plan_id: planId,
      status: 'active',
      seats_purchased: seatsPurchased,
      seats_used: seatsUsed,
      created_by: actor.userId,
      updated_by: actor.userId,
    });
  }

  private async expandLicense(license: OrganizationLicenseRow) {
    const plan = await this.requirePlan(license.plan_id);
    const features = await this.repository.listPlanFeatures(plan.id);
    const overrides = await this.repository.listOverrides(
      license.organization_id,
    );
    const usage = await this.repository.listUsageCounters(
      license.organization_id,
      {
        organization_license_id: license.id,
      },
    );

    return { license, plan, features, overrides, usage };
  }

  private async requireOrganization(organizationId: string): Promise<void> {
    const exists = await this.repository.organizationExists(organizationId);
    if (!exists) throw new NotFoundException('Organization not found');
  }

  private async requirePlan(planId: string): Promise<LicensePlanRow> {
    const plan = await this.repository.getPlanById(planId);
    if (!plan) throw new NotFoundException('License plan not found');
    return plan;
  }

  private async requireAssignablePlan(planId: string): Promise<LicensePlanRow> {
    const plan = await this.requirePlan(planId);
    if (plan.status !== 'active') {
      throw new BadRequestException(
        'Only active license plans can be assigned',
      );
    }
    return plan;
  }

  private async requirePlanFeature(
    planId: string,
    featureId: string,
  ): Promise<LicenseFeatureRow> {
    const feature = await this.repository.getPlanFeature(planId, featureId);
    if (!feature) throw new NotFoundException('Plan feature not found');
    return feature;
  }

  private async requireLiveLicense(
    organizationId: string,
  ): Promise<OrganizationLicenseRow> {
    const license =
      await this.repository.getLiveOrganizationLicense(organizationId);
    if (!license) throw new NotFoundException('Organization license not found');
    return license;
  }

  private async requireChangeRequest(
    requestId: string,
    organizationId?: string,
  ): Promise<LicenseChangeRequestRow> {
    const request = await this.repository.getChangeRequest(
      requestId,
      organizationId,
    );
    if (!request) throw new NotFoundException('Change request not found');
    return request;
  }

  private assertSeatBounds(input: Record<string, unknown>): void {
    const included = input.included_seats as number | null | undefined;
    const max = input.max_seats as number | null | undefined;
    if (included != null && max != null && max < included) {
      throw new BadRequestException(
        'max_seats must be greater than or equal to included_seats',
      );
    }
  }

  private assertSeats(seatsPurchased: number, seatsUsed: number): void {
    if (seatsPurchased < 0 || seatsUsed < 0) {
      throw new BadRequestException('Seat counts cannot be negative');
    }
    if (seatsUsed > seatsPurchased) {
      throw new BadRequestException('seats_used cannot exceed seats_purchased');
    }
  }

  /**
   * Daily sweep (LicenseStatusCron): marks lapsed live licences `expired` and
   * audits each one. Entitlements already ignore a licence past `ends_at`; this
   * makes the stored status, the admin screens and the audit log agree, and is
   * the only thing that ever ends a trial. suspended / past_due are left alone.
   * Returns how many licences were expired. One bad row never stops the rest.
   */
  async expireLapsedLicenses(now = new Date()): Promise<number> {
    const lapsed = await this.repository.listLapsedLiveLicenses(
      now.toISOString(),
    );
    let expired = 0;

    for (const license of lapsed) {
      try {
        const updated = await this.repository.updateOrganizationLicense(
          license.organization_id,
          license.id,
          this.normalizeLicensePatch({ status: 'expired' }),
        );
        await this.audit({
          organizationId: license.organization_id,
          licenseId: license.id,
          eventType: 'license_expired',
          eventSource: 'system',
          before: { status: license.status, ends_at: license.ends_at ?? null },
          after: { status: updated.status },
        });
        expired++;
      } catch (err) {
        this.logger.warn(
          `license ${license.id} could not be expired: ${(err as Error).message}`,
        );
      }
    }

    return expired;
  }

  async getChangeRequestById(requestId: string) {
    const request = await this.repository.getChangeRequest(requestId);
    if (!request) throw new NotFoundException('Change request not found');
    return request;
  }

  /** A licence must end after it starts (an inverted window grants nothing). */
  private assertWindow(startsAt: string | null, endsAt: string | null) {
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      throw new BadRequestException('ends_at must be after starts_at');
    }
  }

  private normalizeLicensePatch(input: Record<string, unknown>) {
    const patch = this.clean(input);
    if (patch.status === 'cancelled' || patch.status === 'expired') {
      patch.cancelled_at = patch.cancelled_at ?? new Date().toISOString();
    } else if (
      patch.status &&
      LIVE_LICENSE_STATUSES.includes(patch.status as OrganizationLicenseStatus)
    ) {
      patch.cancelled_at = null;
    }
    return patch;
  }

  private async audit(input: {
    organizationId?: string | null;
    /**
     * When set, after the audit write we look up every tenant on a live
     * license for this plan and bust each one's entitlements cache. Use this
     * for plan-feature mutations that change entitlements for ALL tenants on
     * the plan (createPlanFeature / updatePlanFeature / deletePlanFeature).
     */
    planId?: string | null;
    licenseId?: string | null;
    actorUserId?: string | null;
    eventType: string;
    eventSource?: string;
    before?: unknown;
    after?: unknown;
  }) {
    await this.repository.createAuditEvent({
      organization_id: input.organizationId ?? null,
      organization_license_id: input.licenseId ?? null,
      actor_user_id: input.actorUserId ?? null,
      event_type: input.eventType,
      event_source: input.eventSource ?? 'super_admin',
      before_data: input.before ?? null,
      after_data: input.after ?? null,
      metadata: {},
    });

    // Invalidate the entitlements cache so the next request sees the change
    // rather than waiting for the 30s TTL.
    //  - Org-scoped events (license / override / change-request) → bust that org.
    //  - Plan-feature events → cascade-bust every tenant on a live license for
    //    that plan. Best-effort: a lookup failure is logged but does not fail
    //    the request (the cache self-heals via TTL).
    if (input.organizationId) {
      this.entitlementsService.bust(input.organizationId);
    } else if (input.planId) {
      try {
        const orgIds = await this.repository.findOrgIdsForPlan(input.planId);
        for (const orgId of orgIds) {
          this.entitlementsService.bust(orgId);
        }
      } catch {
        // swallow — 30s TTL is the safety net
      }
    }
  }

  private clean<T extends Record<string, unknown>>(
    input: T,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
  }
}
