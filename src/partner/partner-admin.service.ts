/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Owner-panel (super admin) provisioning + oversight for partners.
 * Flags an organization as a partner, ensures its profile + system "Backoffice"
 * custom role, and exposes org-wide partner/lead listings for the owner panel.
 * @module src/partner/partner-admin.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntitlementsService } from '../licensing/entitlements.service';
import { getFeatureByKey } from '../licensing/feature-catalog';
import { PartnerRepository } from './partner.repository';
import type {
  CreateResellableItemDto,
  ProvisionPartnerDto,
  UpdateResellableItemDto,
} from './dto/partner.dto';
import { LIVE_LICENSE_STATUSES } from '../licensing/licensing.constants';

/** Backoffice handles licenses, invoices and quotes (sub-ticket 3). */
const BACKOFFICE_PERMISSIONS = {
  can_view_partner_profile: true,
  can_view_partner_leads: true,
  can_view_partner_customers: true,
  can_view_partner_licenses: true,
  can_manage_partner_licenses: true,
  can_view_partner_quotes: true,
  can_manage_partner_quotes: true,
  can_view_partner_invoices: true,
  can_manage_partner_invoices: true,
};

/**
 * Full partner permissions, assigned to the partner org's owner(s) at provision
 * time.
 *
 * Why this role has to exist: the 13 `can_*_partner_*` keys are deliberately NOT
 * in DEFAULT_PERMISSIONS_BY_ROLE (that would hand partner permissions to every
 * owner/admin in every tenant, partner or not). But unlike the frontend's
 * usePermissions().hasPermission, the backend PermissionsGuard has NO owner
 * bypass - calculateEffectivePermissions starts from DEFAULT_PERMISSIONS_BY_ROLE
 * and merges custom roles on top. So without an explicit role assignment a freshly
 * provisioned partner owner would have ZERO partner permissions and the portal
 * would be unusable.
 *
 * Backoffice (above) is the narrower invitee role: sales/finance, no profile,
 * lead, customer or office-user management.
 */
const PARTNER_ADMIN_PERMISSIONS = {
  can_view_partner_profile: true,
  can_manage_partner_profile: true,
  can_view_partner_leads: true,
  can_manage_partner_leads: true,
  can_view_partner_customers: true,
  can_manage_partner_customers: true,
  can_view_partner_licenses: true,
  can_manage_partner_licenses: true,
  can_view_partner_quotes: true,
  can_manage_partner_quotes: true,
  can_view_partner_invoices: true,
  can_manage_partner_invoices: true,
  can_manage_partner_office_users: true,
};

/** Statuses the entitlement resolver treats as a live licence. */

@Injectable()
export class PartnerAdminService {
  private readonly logger = new Logger(PartnerAdminService.name);

  constructor(
    private readonly repo: PartnerRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  async listPartners(filters: {
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    return this.repo.list('organizations', {
      page: filters.page,
      pageSize: filters.pageSize,
      filters: { is_partner: true },
      search: filters.search
        ? { column: 'name', term: filters.search }
        : undefined,
      orderBy: [{ column: 'created_at', ascending: false }],
    });
  }

  /**
   * Every partner's leads, for the owner's review queue.
   *
   * Embeds the submitting partner's org name: the owner is adjudicating BETWEEN
   * partners (leads are global first-come-first-served), so "who submitted this"
   * is decision-critical, not decoration. The embed is disambiguated by FK name
   * because partner_leads has TWO references to organizations (the partner and
   * the resolved customer) and PostgREST cannot guess which one is meant.
   *
   * Stays paginated + filtered - the enrichment rides the existing page query
   * rather than adding an N+1 lookup per row.
   */
  async listAllLeads(filters: {
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    const result = await this.repo.list<
      Record<string, unknown> & {
        partner_organization?: { name?: string; slug?: string } | null;
      }
    >('partner_leads', {
      page: filters.page,
      pageSize: filters.pageSize,
      filters: {
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
      },
      select:
        '*, partner_organization:organizations!partner_leads_organization_id_fkey(id,name,slug)',
    });

    return {
      ...result,
      data: result.data.map(({ partner_organization, ...lead }) => ({
        ...lead,
        partner_name: partner_organization?.name ?? null,
        partner_slug: partner_organization?.slug ?? null,
      })),
    };
  }

  /**
   * Convert an org into a partner.
   *
   * Sets BOTH gates, because they answer different questions and provisioning is
   * the only place that can honestly set both:
   *   - `organizations.is_partner` - the security boundary, enforced server-side
   *     by PartnerGuard and unbypassable from the browser.
   *   - the `module_partners` entitlement - the commercial gate the UI reads.
   *
   * Also assigns the "Partner Admin" role to the org's owners, without which the
   * portal would be provisioned but unusable (see PARTNER_ADMIN_PERMISSIONS).
   *
   * Idempotent: safe to re-run for the same org.
   */
  async provision(actorUserId: string, dto: ProvisionPartnerDto) {
    const organizationId = dto.organization_id;

    // 1. Flag the organization. `.maybeSingle()` returns null (not an error) for a
    // non-existent id, so check the row explicitly - otherwise provisioning a
    // bogus org id silently "succeeds" and returns a half-built payload.
    const flagged = await this.repo.client
      .from('organizations')
      .update({ is_partner: true })
      .eq('id', organizationId)
      .select('id')
      .maybeSingle();

    if (flagged.error) {
      this.logger.error(
        `Failed to flag organization ${organizationId} as partner: ${flagged.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to flag organization as partner',
      );
    }

    if (!flagged.data) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    // 2. Ensure the Backoffice custom role exists.
    let backofficeRoleId: string;
    const existingRole = await this.repo.findOne('custom_roles', {
      organization_id: organizationId,
      name: 'Backoffice',
    });
    if (existingRole) {
      backofficeRoleId = existingRole.id as string;
    } else {
      const role = await this.repo.insert('custom_roles', {
        organization_id: organizationId,
        name: 'Backoffice',
        description: 'Partner back-office: licenses, invoices and quotes.',
        base_role: 'admin',
        is_system: true,
        is_active: true,
        permissions: BACKOFFICE_PERMISSIONS,
      });
      backofficeRoleId = role.id as string;
    }

    // 3. Upsert the partner profile.
    const existingProfile = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });
    const profilePatch = {
      company_name: dto.company_name,
      office_email_domain: dto.office_email_domain ?? null,
      kickback_percent: dto.kickback_percent ?? 0,
      backoffice_role_id: backofficeRoleId,
      updated_by: actorUserId,
    };

    const profile = existingProfile
      ? await this.repo.updateById(
          'partner_profiles',
          existingProfile.id as string,
          profilePatch,
        )
      : await this.repo.insert('partner_profiles', {
          ...profilePatch,
          organization_id: organizationId,
          created_by: actorUserId,
        });

    // 4. Ensure the "Partner Admin" role and assign it to the org's owners, so
    //    someone can actually use the portal (the backend has no owner bypass).
    const partnerAdminRoleId = await this.ensureRole(
      organizationId,
      'Partner Admin',
      'Full Partner Portal access: profile, leads, customers, sales and office users.',
      PARTNER_ADMIN_PERMISSIONS,
    );
    const ownersAssigned = await this.assignRoleToOwners(
      organizationId,
      partnerAdminRoleId,
    );

    // 5. Grant the module_partners entitlement (the commercial gate).
    const licenseId = await this.grantPartnerEntitlement(
      organizationId,
      actorUserId,
    );

    // The resolver caches per org; without this the newly-granted entitlement
    // would not surface until the cache expired.
    this.entitlements.bust(organizationId);

    return {
      organization_id: organizationId,
      backoffice_role_id: backofficeRoleId,
      partner_admin_role_id: partnerAdminRoleId,
      owners_assigned: ownersAssigned,
      license_id: licenseId,
      profile,
    };
  }

  /** Create or update a system custom role, returning its id. Idempotent. */
  private async ensureRole(
    organizationId: string,
    name: string,
    description: string,
    permissions: Record<string, boolean>,
  ): Promise<string> {
    const existing = await this.repo.findOne('custom_roles', {
      organization_id: organizationId,
      name,
    });

    if (existing) {
      // Keep the permission set current if it has been extended since the role
      // was first minted.
      await this.repo.updateById('custom_roles', existing.id as string, {
        permissions,
        is_system: true,
        is_active: true,
      });

      return existing.id as string;
    }

    const role = await this.repo.insert('custom_roles', {
      organization_id: organizationId,
      name,
      description,
      base_role: 'admin',
      is_system: true,
      is_active: true,
      permissions,
    });

    return role.id as string;
  }

  /**
   * Assign a role to every owner of the org. Returns how many owners now hold it.
   * Idempotent - skips owners that already have the assignment.
   */
  private async assignRoleToOwners(
    organizationId: string,
    roleId: string,
  ): Promise<number> {
    const { data: owners, error } = await this.repo.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('role', 'owner');

    if (error) {
      this.logger.error(
        `Failed to load owners for ${organizationId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to load organization owners',
      );
    }

    const ownerIds = (owners ?? []).map(
      (o) => (o as { user_id: string }).user_id,
    );

    if (ownerIds.length === 0) {
      // Not fatal: an org can legitimately be provisioned before its owner joins.
      // The SA can re-run provision() once an owner exists.
      this.logger.warn(
        `Organization ${organizationId} has no owner; Partner Admin role assigned to nobody`,
      );

      return 0;
    }

    const { data: existing } = await this.repo.client
      .from('user_role_assignments')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('role_id', roleId);

    const already = new Set(
      (existing ?? []).map((r) => (r as { user_id: string }).user_id),
    );
    const missing = ownerIds.filter((id) => !already.has(id));

    if (missing.length > 0) {
      await this.repo.insertMany(
        'user_role_assignments',
        missing.map((userId) => ({
          organization_id: organizationId,
          user_id: userId,
          role_id: roleId,
        })),
      );
    }

    return ownerIds.length;
  }

  /**
   * Grant `module_partners` to the partner org.
   *
   * organization_license_feature_overrides.organization_license_id is NOT NULL, so
   * an override needs a licence row to hang off. A licence-less org also resolves
   * as "grandfathered", which the fail-closed sidebar gate treats as "hide" - so a
   * partner with no licence would never see its own portal. Hence: ensure a live
   * licence exists, then override the one key onto it.
   *
   * The licence is created with partner_id = NULL (this is the partner's OWN
   * licence from us, not one a partner sold), so it correctly occupies the
   * one-live-per-org slot that organization_licenses_one_live_per_org guards.
   */
  private async grantPartnerEntitlement(
    organizationId: string,
    actorUserId: string,
  ): Promise<string | null> {
    // A grandfathered (never-licensed, pre-cutoff) org already has every
    // feature, module_partners included. Creating a partner_custom licence for
    // it used to DOWNGRADE it silently from unlimited to catalog defaults
    // (5 users, 3 spaces...). Leave it as it is.
    const before =
      await this.entitlements.getEffectiveEntitlements(organizationId);
    if (before.grandfathered) {
      return null;
    }

    const { data: live, error: liveError } = await this.repo.client
      .from('organization_licenses')
      .select('id')
      .eq('organization_id', organizationId)
      .is('partner_id', null)
      .in('status', LIVE_LICENSE_STATUSES)
      .maybeSingle();

    if (liveError) {
      this.logger.error(
        `Failed to look up licence for ${organizationId}: ${liveError.message}`,
      );
      throw new InternalServerErrorException('Failed to resolve licence');
    }

    let licenseId = (live as { id: string } | null)?.id ?? null;

    if (!licenseId) {
      const plan = await this.repo.findOne('license_plans', {
        plan_key: 'partner_custom',
      });

      if (!plan) {
        throw new InternalServerErrorException(
          'System plan partner_custom is missing; apply the partner portal migration first',
        );
      }

      const created = await this.repo.insert('organization_licenses', {
        organization_id: organizationId,
        plan_id: plan.id,
        status: 'active',
        seats_purchased: 0,
        seats_used: 0,
        starts_at: new Date().toISOString(),
        label: 'Partner Portal access',
        created_by: actorUserId,
        updated_by: actorUserId,
      });

      licenseId = created.id as string;

      await this.repo.insert('license_audit_events', {
        organization_id: organizationId,
        organization_license_id: licenseId,
        actor_user_id: actorUserId,
        event_type: 'license_created_for_partner_provisioning',
        event_source: 'super_admin',
        after_data: { plan_key: 'partner_custom', status: 'active' },
      });
    }

    const { error: overrideError } = await this.repo.client
      .from('organization_license_feature_overrides')
      .upsert(
        {
          organization_license_id: licenseId,
          feature_key: 'module_partners',
          entitlement_value: true,
          reason: 'partner_provisioning',
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_license_id,feature_key' },
      );

    if (overrideError) {
      this.logger.error(
        `Failed to grant module_partners to ${organizationId}: ${overrideError.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to grant the module_partners entitlement',
      );
    }

    return licenseId;
  }

  // ── Global module price list (XE-T738) ─────────────────────────────────────
  // partner_resellable_items is global (no organization_id): one XISUITE-wide
  // list that every partner builds its packages from.

  async listResellableItems() {
    const { data, error } = await this.repo.client
      .from('partner_resellable_items')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return (data ?? []) as ResellableItemRow[];
  }

  async createResellableItem(userId: string, dto: CreateResellableItemDto) {
    assertCatalogItem(dto.item_type, dto.feature_key);

    return this.repo
      .insert<ResellableItemRow>('partner_resellable_items', {
        ...dto,
        label: dto.name,
        created_by: userId,
        updated_by: userId,
      })
      .catch(duplicateKeyMessage(dto.feature_key));
  }

  async updateResellableItem(
    itemId: string,
    userId: string,
    dto: UpdateResellableItemDto,
  ) {
    const existing = await this.repo.findById<ResellableItemRow>(
      'partner_resellable_items',
      itemId,
    );
    if (!existing) {
      throw new NotFoundException('Price list entry not found');
    }
    assertCatalogItem(
      dto.item_type ?? existing.item_type,
      dto.feature_key ?? existing.feature_key,
    );

    return this.repo
      .updateById<ResellableItemRow>('partner_resellable_items', itemId, {
        ...dto,
        ...(dto.name ? { label: dto.name } : {}),
        updated_by: userId,
      })
      .catch(duplicateKeyMessage(dto.feature_key ?? existing.feature_key));
  }

  /**
   * Deactivate rather than delete: existing packages keep referencing the key,
   * partners just can no longer pick it for new rows.
   */
  async deactivateResellableItem(
    itemId: string,
    userId: string,
  ): Promise<ResellableItemRow> {
    return this.updateResellableItem(itemId, userId, { is_active: false });
  }
}

/**
 * The key must be a real catalog feature, and a "module" row must be a module
 * (module_*) - a limit like limit_users is sold as a user_seat or addon.
 */
function assertCatalogItem(itemType: string, featureKey: string) {
  if (!getFeatureByKey(featureKey)) {
    throw new BadRequestException(`Unknown feature key "${featureKey}"`);
  }
  if (itemType === 'module' && !featureKey.startsWith('module_')) {
    throw new BadRequestException(
      `A module row needs a module key (module_*), got "${featureKey}"`,
    );
  }
}

function duplicateKeyMessage(featureKey: string) {
  return (err: unknown): never => {
    if (err instanceof ConflictException) {
      throw new ConflictException(
        `"${featureKey}" is already on the price list`,
      );
    }
    throw err;
  };
}

/** A partner_resellable_items row (global module price list, XE-T738). */
export interface ResellableItemRow {
  id: string;
  item_type: 'module' | 'user_seat' | 'addon';
  feature_key: string;
  [column: string]: unknown;
}
