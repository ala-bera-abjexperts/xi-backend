import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { MODULE_TYPE_TO_FEATURE_KEY } from '../organization-modules/module-feature-map';
import type { OrganizationLicenseStatus } from './dto/licensing.dto';
import type { FeatureType } from './feature-catalog';
import { FEATURE_CATALOG, validateCatalog } from './feature-catalog';
import type {
  LicenseFeatureRow,
  LicenseOverrideRow,
  OrganizationLicenseRow,
} from './licensing.repository';
import { LicensingRepository } from './licensing.repository';
import { LIVE_LICENSE_STATUSES } from './licensing.constants';

/**
 * Statuses that count as a live/effective subscription. MUST stay in sync with
 * LIVE_LICENSE_STATUSES in licensing.service.ts and src/models/licensing.model.ts.
 *
 * A status NOT in this list (cancelled, expired) means the tenant is LOCKED to
 * the free tier, not grandfathered. Only a tenant that never held a license at
 * all is grandfathered. See resolve().
 */

/** What a signed on-prem licence grants (artifact `features` / `limits`). */
export interface OnPremEntitlementSnapshot {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
}

/**
 * What the on-prem licence gate reports. `snapshot` is the newest artifact
 * whose signature verified (even if it has since expired), or null if none
 * ever did; `entitled` is false once the box is past its grace period.
 */
export interface OnPremGateResult {
  entitled: boolean;
  readOnly: boolean;
  snapshot: OnPremEntitlementSnapshot | null;
}

export type EntitlementSource =
  | 'override'
  | 'plan'
  | 'catalog_default'
  | 'grandfathered';

export interface ResolvedFeature {
  key: string;
  /** true unless type='boolean' && value === false (limits are always "enabled"). */
  enabled: boolean;
  /** raw value from override / plan / catalog default. */
  value: unknown;
  source: EntitlementSource;
  /** For limits: null = unlimited. For non-limits: undefined. */
  limit?: number | null;
}

export interface EffectiveEntitlements {
  organizationId: string;
  grandfathered: boolean;
  licenseStatus: OrganizationLicenseStatus | null;
  /** ISO timestamp when this snapshot was computed. */
  resolvedAt: string;
  has(key: string): boolean;
  getLimit(key: string): number | null;
  getValue(key: string): unknown;
  /**
   * All resolved features keyed by feature_key. Includes catalog defaults for
   * keys not present in plan/overrides UNLESS grandfathered. When grandfathered,
   * this map is empty (and `has()` returns true for any key).
   */
  raw: ReadonlyMap<string, ResolvedFeature>;
}

/**
 * JSON-serializable snapshot of EffectiveEntitlements (the `raw` Map is flattened
 * into plain objects). Consumed by the bootstrap payload and the SA entitlements
 * endpoint. `null` ⇒ no active org or the resolve failed — treat as grandfathered.
 */
export interface EntitlementsSnapshot {
  grandfathered: boolean;
  licenseStatus: OrganizationLicenseStatus | null;
  resolvedAt: string;
  /** key → enabled. */
  features: Record<string, boolean>;
  /** Only `category: 'limits'` keys. value → limit (number) or null (unlimited). */
  limits: Record<string, number | null>;
  /** key → where the entitlement came from. */
  sources: Record<string, EntitlementSource>;
}

/**
 * The result of a {@link EntitlementsService.checkLimit} call.
 *
 * `limit: null` means no finite ceiling applies (unlimited plan, or a
 * grandfathered tenant), in which case `current` is null too because the count
 * was never run.
 */
export interface LimitVerdict {
  key: string;
  limit: number | null;
  current: number | null;
  /** True when the create being checked would take the tenant past `limit`. */
  exceeded: boolean;
}

interface CacheEntry {
  promise: Promise<EffectiveEntitlements>;
  expiresAt: number;
}

/**
 * Resolves a tenant's effective feature entitlements by merging their live
 * license, plan features, and active overrides by precedence:
 *
 *   active override (not expired) > plan feature > catalog default > grandfathered
 *
 * GRANDFATHERED SAFETY (rollout posture): a tenant that has NEVER held a license
 * row gets `has()===true` for everything and `getLimit()===null` (unlimited), so
 * introducing licensing cannot lock out an existing tenant.
 *
 * A tenant whose license was CANCELLED, EXPIRED, or whose paid window lapsed is
 * a different case and is NOT grandfathered: it resolves to the free tier with
 * `grandfathered:false`. That distinction is load-bearing. It was previously
 * impossible to reach, because getLiveLicenses() filters those statuses out in
 * SQL, so the resolver saw "no license" and granted unlimited access. Cancelling
 * a license therefore GRANTED more access than the plan it replaced, and
 * FeatureGuard's LICENSE_INACTIVE branch could never fire.
 *
 * `grandfathered` is the flag both FeatureGuard and the frontend
 * FeatureRouteGuard key off, so it must be false whenever the tenant is meant to
 * be locked; otherwise the API 403s while the UI still renders the module.
 *
 * Results are cached in-memory for a short TTL and busted from
 * LicensingService.audit() on any org-scoped license mutation.
 */
@Injectable()
export class EntitlementsService implements OnModuleInit {
  private static readonly CACHE_TTL_MS = 30_000;

  private readonly logger = new Logger(EntitlementsService.name);

  // TODO(scaling): add LRU eviction if the number of cached orgs grows large.
  // Entries expire on their own via TTL, so unbounded growth is only a concern
  // at very high active-org counts.
  private readonly cache = new Map<string, CacheEntry>();

  private hitCount = 0;
  private missCount = 0;

  /**
   * On-premise lock hook. Null on SaaS, where nothing ever registers one, so
   * the SaaS resolution path is byte-identical to before.
   *
   * A callback rather than an injected dependency because the on-prem module
   * imports LicensingModule to get this service; injecting the other way round
   * would be a cycle. The on-prem module registers itself at boot instead.
   */
  private onPremGate: (() => Promise<OnPremGateResult>) | null = null;

  constructor(private readonly repository: LicensingRepository) {}

  /**
   * Called once by OnPremLicenseModule at boot. The gate reports what the
   * vendor-signed licence on this box grants (see OnPremGateResult).
   */
  registerOnPremGate(gate: () => Promise<OnPremGateResult>): void {
    this.onPremGate = gate;
    this.cache.clear();
    this.logger.log('on-premise licence gate registered');
  }

  /**
   * Boot-time validation (never throws — catalog issues are loud but non-blocking):
   *   1. validateCatalog() — log any structural errors at ERROR level.
   *   2. Reconcile DB feature keys against the catalog — WARN on unknown keys.
   */
  async onModuleInit(): Promise<void> {
    const errors = validateCatalog();
    if (errors.length > 0) {
      this.logger.error(
        `feature catalog validation failed with ${errors.length} error(s):`,
      );
      for (const error of errors) {
        this.logger.error(`  - ${error}`);
      }
    }

    this.logger.log(
      `feature catalog loaded: ${FEATURE_CATALOG.length} features`,
    );

    try {
      const dbKeys = await this.repository.listDistinctPlanFeatureKeys();
      const catalogKeys = new Set(FEATURE_CATALOG.map((entry) => entry.key));
      const unknownKeys = dbKeys.filter((key) => !catalogKeys.has(key));

      for (const key of unknownKeys) {
        this.logger.warn(
          `License feature key '${key}' is in the database but not in the catalog. ` +
            `Plans referencing this key still work but it won't appear in the catalog picker.`,
        );
      }

      // Phase 5: persist the unknown-key list to a dev-convenience file so an
      // operator can audit it without scraping logs. Best-effort: failures are
      // logged but never crash boot (e.g. read-only filesystem in Docker).
      await this.writeUnknownKeysFile(unknownKeys);
    } catch (error) {
      // Never block boot on a reconciliation read failure.
      this.logger.warn(
        `could not reconcile DB feature keys against the catalog at boot: ${
          (error as Error).message
        }`,
      );
    }
  }

  /**
   * Phase 5: write the current unknown-key list to
   * `tasks/license-enforcement/unknown-feature-keys.txt`. Overwritten each
   * boot so it always reflects the current state. Write failures are WARN-only
   * — the file is dev convenience, not a runtime dependency.
   */
  private async writeUnknownKeysFile(unknownKeys: string[]): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const filepath = path.resolve(
        process.cwd(),
        '..',
        'tasks',
        'license-enforcement',
        'unknown-feature-keys.txt',
      );
      const generatedAt = new Date().toISOString();
      const body =
        unknownKeys.length === 0
          ? `# Generated ${generatedAt}\n# No unknown keys.\n`
          : `# Generated ${generatedAt}\n# ${unknownKeys.length} unknown keys:\n${unknownKeys.join('\n')}\n`;
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, body, 'utf-8');
    } catch (err) {
      this.logger.warn(
        `Failed to write unknown-feature-keys.txt: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Returns the effective entitlements for a tenant. Cached for CACHE_TTL_MS.
   * Concurrent calls for the same org share one in-flight resolution.
   */
  getEffectiveEntitlements(
    organizationId: string,
  ): Promise<EffectiveEntitlements> {
    const now = Date.now();
    const cached = this.cache.get(organizationId);

    if (cached && cached.expiresAt > now) {
      this.hitCount += 1;

      return cached.promise;
    }

    this.missCount += 1;

    const promise = this.resolve(organizationId);

    this.cache.set(organizationId, {
      promise,
      expiresAt: now + EntitlementsService.CACHE_TTL_MS,
    });

    // If resolution rejects, drop the (still-cached) entry so the next call
    // retries instead of replaying the failure for CACHE_TTL_MS. We only delete
    // the entry if it is still the one we created (a bust/refresh may have
    // replaced it in the meantime).
    promise.catch(() => {
      const current = this.cache.get(organizationId);
      if (current && current.promise === promise) {
        this.cache.delete(organizationId);
      }
    });

    return promise;
  }

  /** Invalidate the cache for one tenant. Called from LicensingService.audit(). */
  bust(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /** Invalidate the entire cache. Useful in tests. */
  bustAll(): void {
    this.cache.clear();
  }

  /** For debug/admin tooling. Snapshot of cache size + hit/miss counters. */
  stats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: this.hitCount,
      misses: this.missCount,
    };
  }

  /**
   * Flattens an EffectiveEntitlements into a JSON-serializable snapshot for the
   * bootstrap payload and the SA entitlements endpoint. Returns null for null
   * input (no active org / resolve failure → frontend treats as grandfathered).
   * For grandfathered tenants the `raw` map is empty, so we enumerate the catalog
   * as all-enabled / unlimited to give the frontend a concrete shape.
   */
  static toSnapshot(
    entitlements: EffectiveEntitlements | null,
  ): EntitlementsSnapshot | null {
    if (!entitlements) {
      return null;
    }

    const features: Record<string, boolean> = {};
    const limits: Record<string, number | null> = {};
    const sources: Record<string, EntitlementSource> = {};
    const limitKeys = new Set(
      FEATURE_CATALOG.filter((entry) => entry.category === 'limits').map(
        (entry) => entry.key,
      ),
    );

    if (entitlements.grandfathered) {
      for (const entry of FEATURE_CATALOG) {
        features[entry.key] = true;
        sources[entry.key] = 'grandfathered';
        if (entry.category === 'limits') {
          limits[entry.key] = null;
        }
      }
    } else {
      for (const [key, resolved] of entitlements.raw) {
        features[key] = resolved.enabled;
        sources[key] = resolved.source;
        if (limitKeys.has(key)) {
          limits[key] = resolved.limit ?? null;
        }
      }
    }

    return {
      grandfathered: entitlements.grandfathered,
      licenseStatus: entitlements.licenseStatus,
      resolvedAt: entitlements.resolvedAt,
      features,
      limits,
      sources,
    };
  }

  private async resolve(
    organizationId: string,
  ): Promise<EffectiveEntitlements> {
    // On-premise: the vendor-signed artifact is the source of truth, and it
    // outranks anything in this database. The customer owns these rows, so a
    // local licence record could simply be inserted by hand; the signature
    // cannot be. When the gate says "not entitled" the box drops to the free
    // tier no matter what the local tables claim.
    // On-prem the signed licence is the ONLY source: its features and limits
    // are what the box may use, and local organization_licenses rows (which the
    // customer could edit) are never consulted.
    if (this.onPremGate) {
      const gate = await this.onPremGate();

      if (gate.snapshot) {
        return this.fromSnapshot(organizationId, gate.snapshot, gate.entitled);
      }

      // No licence file has ever verified: full access during the setup
      // grace, the free tier once it is over (and the box is read-only).
      return gate.entitled
        ? this.buildGrandfathered(organizationId, null)
        : this.buildFreeTier(organizationId, 'expired');
    }

    const allLive = await this.repository.getLiveLicenses(organizationId);

    // Universal expiry (upper-bound) filter. `ends_at` is a new, always-null
    // column for every pre-partner license, so this is a guaranteed no-op for
    // existing tenants; only partner-sold licenses set ends_at.
    const now = Date.now();
    const unexpired = allLive.filter(
      (lic) => !lic.ends_at || new Date(lic.ends_at).getTime() >= now,
    );

    // getLiveLicenses already filters status in SQL; re-checking here keeps a
    // non-live license from ever reaching the aggregator if that query is
    // changed, since a cancelled license granting entitlements is the exact
    // failure this resolver must not have.
    const statusLive = unexpired.filter((lic) =>
      LIVE_LICENSE_STATUSES.includes(lic.status),
    );

    // A licence whose window has not STARTED yet grants nothing today. When
    // every live licence is future-dated, the tenant resolves exactly as if it
    // had none (below), instead of falling through to "grandfathered" (which
    // used to hand a not-yet-started licence unlimited access).
    const liveLicenses = statusLive.filter(
      (lic) => new Date(lic.starts_at).getTime() <= now,
    );

    // Grandfathering posture (deliberate rollout policy): no live license at
    // all ⇒ full access. Report the status of the license we rejected, if any,
    // so the policy guard can still deny a cancelled/expired tenant.
    //
    // `unexpired` cannot supply that status: it derives from getLiveLicenses(),
    // which filters status in SQL, so a cancelled/expired row never reaches it
    // and `unexpired[0]?.status` was ALWAYS null. That made FeatureGuard's
    // LICENSE_INACTIVE branch unreachable and turned "cancel a license" into
    // "grant unlimited access". We therefore ask for the rejected row directly.
    //
    // An `ends_at`-lapsed row is still `active` in the DB (nothing flips it), so
    // it is reported as 'expired' here: to the policy layer a lapsed license and
    // an expired one are the same thing.
    if (liveLicenses.length === 0) {
      // 1. Defence in depth: if getLiveLicenses ever regresses and hands us a
      //    non-live row, believe what is already in hand rather than querying.
      const nonLive = unexpired.find(
        (lic) => !LIVE_LICENSE_STATUSES.includes(lic.status),
      );

      // 2. Every license was dropped by the ends_at window, i.e. the paid period
      //    ended. Nothing flips `status` when ends_at passes, so the row still
      //    reads 'active'; to the policy layer that is the same as expired.
      const lapsed = !nonLive && unexpired.length === 0 && allLive.length > 0;

      // 3. Otherwise ask for the rejected row directly, because the SQL filter
      //    in getLiveLicenses hid it from us.
      const rejected: OrganizationLicenseStatus | null =
        nonLive?.status ??
        (lapsed
          ? 'expired'
          : ((await this.repository.getLatestInactiveLicense(organizationId))
              ?.status ?? null));

      // A tenant that NEVER had a license keeps the grandfathered posture
      // (unlimited). A tenant whose license was cancelled or lapsed is LOCKED
      // to the free tier instead: `grandfathered:false` is what makes both
      // FeatureGuard and the frontend FeatureRouteGuard enforce, so returning
      // `true` here would 403 the API while the UI still rendered the module.
      if (rejected !== null) {
        return this.buildFreeTier(organizationId, rejected);
      }

      // Never licensed. Only tenants that existed before the licensing cutoff
      // keep the unlimited rollout posture; an org created after it starts on
      // the Free tier (every creation path: super admin, self-signup, partner).
      if (
        await this.repository.isCreatedBeforeGrandfatherCutoff(organizationId)
      ) {
        return this.buildGrandfathered(organizationId, null);
      }

      return this.buildFreeTier(organizationId, null);
    }

    // EVERY tenant resolves through the aggregator, including single-license
    // ones. It is correct for n=1 and, unlike the per-org merge it replaced,
    // it scopes each override to its owning license (so a dead license cannot
    // bleed one in) and honours starts_at.
    return this.resolveMultiLicense(organizationId, liveLicenses, now);
  }

  /**
   * License aggregation — the single resolution path for every licensed tenant
   * (n=1 included). Each license contributes its plan features overlaid by ITS
   * OWN active overrides; then boolean/text/json features are OR-ed (any
   * license that grants it wins) and `limit` features are SUMMED across the
   * licenses that explicitly grant them (any unlimited ⇒ unlimited). Catalog
   * defaults apply only when no license grants a key, so defaults are never
   * double-counted. For n=1 every rule degenerates to "that license's value",
   * which is why the old single-license path could be deleted outright.
   */
  private async resolveMultiLicense(
    organizationId: string,
    liveLicenses: OrganizationLicenseRow[],
    now: number,
  ): Promise<EffectiveEntitlements> {
    // Honor the start of each license's window (a license that has not started
    // yet contributes nothing). ends_at was already applied.
    const inWindow = liveLicenses.filter(
      (lic) => new Date(lic.starts_at).getTime() <= now,
    );

    if (inWindow.length === 0) {
      return this.buildGrandfathered(
        organizationId,
        liveLicenses[0]?.status ?? null,
      );
    }

    // Dedupe plan-feature fetches by plan_id (licenses often share partner_custom).
    // Overrides are fetched for the in-window licenses ONLY, so an override on a
    // license we are not aggregating cannot even widen the key universe below.
    const planIds = [...new Set(inWindow.map((lic) => lic.plan_id))];
    const [planFeatureLists, overrides] = await Promise.all([
      Promise.all(
        planIds.map((planId) => this.repository.listPlanFeatures(planId)),
      ),
      this.repository.listOverridesForLicenses(
        organizationId,
        inWindow.map((lic) => lic.id),
      ),
    ]);

    const planFeaturesByPlan = new Map<string, LicenseFeatureRow[]>(
      planIds.map((planId, index) => [planId, planFeatureLists[index]]),
    );

    // Group active overrides by their owning license id.
    const overridesByLicense = new Map<string, LicenseOverrideRow[]>();
    for (const override of overrides) {
      if (
        override.expires_at &&
        new Date(override.expires_at).getTime() <= now
      ) {
        continue;
      }
      const list =
        overridesByLicense.get(override.organization_license_id) ?? [];
      list.push(override);
      overridesByLicense.set(override.organization_license_id, list);
    }

    // Explicit value of a key for one license (override > plan), or undefined.
    const explicitFor = (
      lic: OrganizationLicenseRow,
      key: string,
    ): { value: unknown; source: EntitlementSource } | undefined => {
      const override = (overridesByLicense.get(lic.id) ?? []).find(
        (o) => o.feature_key === key,
      );
      if (override) {
        return { value: override.entitlement_value, source: 'override' };
      }
      const planFeature = (planFeaturesByPlan.get(lic.plan_id) ?? []).find(
        (f) => f.feature_key === key,
      );
      if (planFeature) {
        return { value: planFeature.entitlement_value, source: 'plan' };
      }

      return undefined;
    };

    // Universe of keys = catalog ∪ every plan key ∪ every override key.
    const catalogByKey = new Map(
      FEATURE_CATALOG.map((entry) => [entry.key, entry]),
    );
    const allKeys = new Set<string>(catalogByKey.keys());
    for (const features of planFeaturesByPlan.values()) {
      for (const feature of features) allKeys.add(feature.feature_key);
    }
    for (const list of overridesByLicense.values()) {
      for (const override of list) allKeys.add(override.feature_key);
    }

    const raw = new Map<string, ResolvedFeature>();

    for (const key of allKeys) {
      const entry = catalogByKey.get(key);
      const type: FeatureType | null = entry?.type ?? null;
      const grants = inWindow
        .map((lic) => explicitFor(lic, key))
        .filter((g): g is { value: unknown; source: EntitlementSource } => !!g);

      if (type === 'limit') {
        if (grants.length === 0) {
          raw.set(
            key,
            this.buildResolved(
              key,
              entry!.defaultValue,
              'catalog_default',
              type,
            ),
          );
          continue;
        }

        const source: EntitlementSource = grants.some(
          (g) => g.source === 'override',
        )
          ? 'override'
          : 'plan';

        if (grants.some((g) => g.value === null)) {
          raw.set(key, this.buildResolved(key, null, source, type));
          continue;
        }

        // A limit that is neither a number nor null is malformed. Pass it to
        // buildResolved untouched so it warns and fails open (unlimited);
        // summing would coerce it to 0 and silently lock the tenant out.
        const malformed = grants.find((g) => typeof g.value !== 'number');
        if (malformed) {
          raw.set(key, this.buildResolved(key, malformed.value, source, type));
          continue;
        }

        raw.set(
          key,
          this.buildResolved(
            key,
            grants.reduce((sum, g) => sum + (g.value as number), 0),
            source,
            type,
          ),
        );
        continue;
      }

      // boolean / text / json / custom: any granting license that ENABLES the
      // feature wins (OR); else fall back to the first grant; else catalog default.
      if (grants.length === 0) {
        const def: unknown = entry ? entry.defaultValue : false;
        raw.set(key, this.buildResolved(key, def, 'catalog_default', type));
        continue;
      }

      const enabledGrant = grants.find((g) =>
        this.isValueEnabled(g.value, type),
      );
      const chosen = enabledGrant ?? grants[0];
      raw.set(key, this.buildResolved(key, chosen.value, chosen.source, type));
    }

    // Report the MOST SEVERE status across the in-window licenses (not the
    // newest), so the policy guard still sees past_due/suspended even when a
    // newer, healthier license is also live.
    const severity: Record<string, number> = {
      active: 0,
      trialing: 1,
      past_due: 2,
      suspended: 3,
    };
    const worstStatus = inWindow.reduce(
      (worst, lic) =>
        (severity[lic.status] ?? 0) > (severity[worst] ?? 0)
          ? lic.status
          : worst,
      inWindow[0].status,
    );

    return this.buildEntitlements(organizationId, worstStatus, raw);
  }

  /** Mirror of the enabled-logic in buildResolved, for aggregation decisions. */
  private isValueEnabled(value: unknown, type: FeatureType | null): boolean {
    if (type === 'limit') return true;
    if (type === 'boolean') return value === true;
    if (type === 'text' || type === 'json') {
      return value != null && value !== '';
    }

    return Boolean(value);
  }

  /**
   * Builds a ResolvedFeature. `type` is the catalog type for known keys, or
   * `null` for custom keys (which fall back to a truthy enabled-check).
   */
  private buildResolved(
    key: string,
    value: unknown,
    source: EntitlementSource,
    type: FeatureType | null,
  ): ResolvedFeature {
    if (type === 'limit') {
      let limit: number | null;
      if (typeof value === 'number') {
        limit = value;
      } else if (value === null) {
        limit = null;
      } else {
        this.logger.warn(
          `feature '${key}' is a limit but its value (${JSON.stringify(
            value,
          )}) is not a number or null; treating as unlimited.`,
        );
        limit = null;
      }

      return { key, value, source, enabled: true, limit };
    }

    let enabled: boolean;
    if (type === 'boolean') {
      enabled = value === true;
    } else if (type === 'text' || type === 'json') {
      enabled = value != null && value !== '';
    } else {
      // Custom key (no catalog type): truthy check.
      enabled = Boolean(value);
    }

    return { key, value, source, enabled };
  }

  /**
   * Drops `space_modules.module_type` values the tenant is not entitled to.
   *
   * `space_modules` is the one module registry licensing never consulted: rows
   * are seeded per space by `create_default_space_modules` and read back
   * verbatim, so a tenant with no `module_file_explorer` entitlement was still
   * told the module was enabled. The controller then 403s via `@RequireFeature`
   * and the user sees a nav entry that cannot be opened.
   *
   * This aligns the LISTING with the enforcement that already exists. It is not
   * itself a security boundary: `@RequireFeature` on the controllers is, and
   * stays. Consequently this is only applied to nav/display reads, never to the
   * settings tab (an admin must still see a module to disable it) and never to
   * reporting (filtering would silently distort historical counts).
   *
   * A module type with no catalog mapping is kept, matching
   * `OrganizationModulesService.isEnabled`, where an unmapped type falls through
   * to the legacy toggle rather than being denied.
   */
  async filterEntitledModuleTypes(
    organizationId: string,
    moduleTypes: readonly string[],
  ): Promise<string[]> {
    if (moduleTypes.length === 0) return [];

    const entitlements = await this.getEffectiveEntitlements(organizationId);

    return EntitlementsService.filterModuleTypesBy(moduleTypes, (key) =>
      entitlements.has(key),
    );
  }

  /**
   * Reports whether a create would exceed a plan limit, WITHOUT refusing it.
   *
   * Numeric limits (`limit_spaces`, `limit_users`, ...) have been in the catalog
   * and sold since licensing shipped, but no production code path ever called
   * `getLimit()`, so every one of them was advertised and unenforced. Turning
   * them on as hard blocks in one step would refuse creates for tenants who are
   * already over a ceiling they were never told about, at the moment they next
   * try to work.
   *
   * So this warns first. It logs a single structured line per breach and returns
   * the verdict; the caller does nothing with it beyond that. Flipping any one
   * call site to enforcement is then a two-line change there (throw when
   * `verdict.exceeded`), with the log already telling you how many tenants that
   * would affect.
   *
   * `countCurrent` is a thunk on purpose: it runs ONLY when a finite limit
   * applies. A grandfathered or unlimited tenant resolves `getLimit()` to null
   * and pays no extra query.
   *
   * `opts.enforce` turns a breach into a 403 `LIMIT_EXCEEDED`. Only seats
   * (`limit_users`) are enforced today, via {@link assertSeatAvailable}; the
   * other limits stay warn-only. A null limit (grandfathered / unlimited) never
   * blocks.
   */
  async checkLimit(
    organizationId: string,
    key: string,
    countCurrent: () => Promise<number>,
    opts: { enforce?: boolean } = {},
  ): Promise<LimitVerdict> {
    const entitlements = await this.getEffectiveEntitlements(organizationId);
    const limit = entitlements.getLimit(key);

    if (limit === null) {
      return { key, limit: null, current: null, exceeded: false };
    }

    const current = await countCurrent();
    // `current` is the count BEFORE the create, so the create is the (current+1)th.
    const exceeded = current + 1 > limit;

    if (exceeded && opts.enforce) {
      this.logger.warn(
        `[limit-exceeded] org=${organizationId} key=${key} limit=${limit} current=${current} action=blocked`,
      );
      throw new ForbiddenException({
        code: 'LIMIT_EXCEEDED',
        message:
          key === 'limit_users'
            ? `Seat limit reached: ${current} of ${limit} seats are in use (active members and pending invitations). Ask your partner or administrator to add seats.`
            : `Plan limit reached for ${key}: ${current} of ${limit}.`,
      });
    }

    if (exceeded) {
      this.logger.warn(
        `[limit-exceeded] org=${organizationId} key=${key} limit=${limit} current=${current} action=allowed(warn-only)`,
      );
    }

    return { key, limit, current, exceeded };
  }
  /**
   * Refuses (403 LIMIT_EXCEEDED) adding ONE more seat past the tenant's
   * `limit_users`. Seats = active members + pending invitations, because every
   * pending invite becomes a member on acceptance.
   *
   * Call it on every path that creates a NEW member or invitation. Do not call
   * it when accepting an invitation (the invite already holds the seat) or for a
   * user who is already an active member. Users already over the limit keep
   * access; only new seats are refused.
   *
   * ponytail: count-then-insert is not atomic, so two simultaneous invites can
   * overshoot the limit by one. Move the check into a DB function with a row
   * lock if that ever matters.
   */
  async assertSeatAvailable(organizationId: string): Promise<void> {
    await this.checkLimit(
      organizationId,
      'limit_users',
      () => this.repository.countSeatsInUse(organizationId),
      { enforce: true },
    );
  }

  /**
   * The pure form of {@link filterEntitledModuleTypes}, for callers that already
   * hold a resolved entitlement set (the bootstrap payload resolves one for its
   * own `entitlements` slice, so re-resolving would be a second round trip for
   * an answer it already has).
   */
  static filterModuleTypesBy(
    moduleTypes: readonly string[],
    isEntitled: (featureKey: string) => boolean,
  ): string[] {
    return moduleTypes.filter((moduleType) => {
      const featureKey =
        MODULE_TYPE_TO_FEATURE_KEY[
          moduleType as keyof typeof MODULE_TYPE_TO_FEATURE_KEY
        ];

      return featureKey ? isEntitled(featureKey) : true;
    });
  }

  /**
   * The locked / free-tier entitlement set, derived from the COMPILED catalog
   * (`suggestedForFreePlan`) rather than from any database row.
   *
   * Compiled on purpose: on-premise customers own their database, so a free
   * tier read from `license_plans` there would be editable by the very person
   * it constrains. This is the single definition of "free" used by both the
   * SaaS cancelled/expired path and the on-prem locked path.
   *
   * Booleans in the free set resolve to `true` (the feature IS included in
   * free); limits resolve to their catalog `defaultValue` ceiling. Everything
   * outside the free set is simply absent from the map, so `has()` returns
   * false and `getLimit()` returns null.
   */
  /**
   * Entitlements exactly as a signed on-prem licence grants them. A feature
   * is on only if the artifact says so; a limit is the artifact's number (null
   * = unlimited). Nothing comes from local rows or catalog defaults.
   */
  fromSnapshot(
    organizationId: string,
    snapshot: OnPremEntitlementSnapshot,
    entitled: boolean,
  ): EffectiveEntitlements {
    const raw = new Map<string, ResolvedFeature>();
    const types = new Map(FEATURE_CATALOG.map((e) => [e.key, e.type]));

    for (const [key, enabled] of Object.entries(snapshot.features ?? {})) {
      if (key in (snapshot.limits ?? {})) continue;
      raw.set(
        key,
        this.buildResolved(
          key,
          enabled === true,
          'override',
          types.get(key) ?? 'boolean',
        ),
      );
    }

    for (const [key, limit] of Object.entries(snapshot.limits ?? {})) {
      raw.set(key, this.buildResolved(key, limit, 'override', 'limit'));
    }

    return this.buildEntitlements(
      organizationId,
      entitled ? 'active' : 'expired',
      raw,
    );
  }

  buildFreeTier(
    organizationId: string,
    licenseStatus: OrganizationLicenseStatus | null,
  ): EffectiveEntitlements {
    const raw = new Map<string, ResolvedFeature>();

    for (const entry of FEATURE_CATALOG) {
      if (!entry.suggestedForFreePlan) continue;

      const value = entry.type === 'limit' ? entry.defaultValue : true;

      raw.set(
        entry.key,
        this.buildResolved(entry.key, value, 'catalog_default', entry.type),
      );
    }

    return this.buildEntitlements(organizationId, licenseStatus, raw);
  }

  private buildGrandfathered(
    organizationId: string,
    licenseStatus: OrganizationLicenseStatus | null,
  ): EffectiveEntitlements {
    const raw: ReadonlyMap<string, ResolvedFeature> = new Map();

    return Object.freeze({
      organizationId,
      grandfathered: true,
      licenseStatus,
      resolvedAt: new Date().toISOString(),
      raw,
      has: () => true,
      getLimit: () => null,
      getValue: () => undefined,
    });
  }

  private buildEntitlements(
    organizationId: string,
    licenseStatus: OrganizationLicenseStatus | null,
    raw: ReadonlyMap<string, ResolvedFeature>,
  ): EffectiveEntitlements {
    return Object.freeze({
      organizationId,
      grandfathered: false,
      licenseStatus,
      resolvedAt: new Date().toISOString(),
      raw,
      has: (key: string) => raw.get(key)?.enabled === true,
      getLimit: (key: string) => raw.get(key)?.limit ?? null,
      getValue: (key: string) => raw.get(key)?.value,
    });
  }
}
