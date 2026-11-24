import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  OrganizationModuleRepository,
  type OrganizationModuleRow,
} from './organization-module.repository';
import {
  ALLOWED_ORGANIZATION_MODULES,
  MODULE_TYPE_TO_FEATURE_KEY,
  type OrganizationModuleType,
} from './module-feature-map';

// Moved to `module-feature-map.ts` (a leaf file with no imports) so that
// `src/licensing/` can consume the mapping without importing this service, which
// imports EntitlementsService. Re-exported here so existing callers are unchanged.
export {
  ALLOWED_ORGANIZATION_MODULES,
  MODULE_TYPE_TO_FEATURE_KEY,
} from './module-feature-map';
export type { OrganizationModuleType } from './module-feature-map';

/**
 * Legacy per-org module toggles. As of the license-enforcement integration,
 * this layer is SECONDARY to the license entitlements layer for modules that
 * have a catalog feature key.
 *
 * Decision matrix for `isEnabled(org, type)` when a feature key is mapped:
 *   - NOT entitled                              → false  (regardless of legacy row)
 *   - Entitled AND legacy row missing           → true   (default ON for entitled tenants)
 *   - Entitled AND legacy row is_enabled=true   → true
 *   - Entitled AND legacy row is_enabled=false  → false  (tenant admin opt-out)
 *
 * For module types with no mapped feature key (none today; every allowed type
 * is mapped), the legacy `row?.is_enabled === true` check applies — absent row
 * defaults to false, preserving the original behaviour.
 *
 * Use `isLegacyEnabled(org, type)` when you want the raw stored toggle value
 * without entitlement consultation (e.g. settings UI reflecting user's saved
 * choice independent of license state).
 */
@Injectable()
export class OrganizationModulesService {
  constructor(
    private readonly repository: OrganizationModuleRepository,
    private readonly auditLogs: AuditLogsService,
    private readonly permissionsService: PermissionsService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  assertAllowedModule(
    moduleType: string,
  ): asserts moduleType is OrganizationModuleType {
    if (
      !ALLOWED_ORGANIZATION_MODULES.includes(
        moduleType as OrganizationModuleType,
      )
    ) {
      throw new BadRequestException('Unknown module_type');
    }
  }

  /**
   * Combined check: entitlement layer AND legacy toggle.
   *
   * For modules with a catalog feature key: returns true iff the tenant is
   * entitled AND the legacy row is not explicitly disabled (absent row = enabled).
   *
   * For modules without a catalog feature key (none today): falls back to the
   * legacy `row?.is_enabled === true` check — absent row = false.
   */
  async isEnabled(
    organizationId: string,
    moduleType: OrganizationModuleType,
  ): Promise<boolean> {
    const featureKey = MODULE_TYPE_TO_FEATURE_KEY[moduleType];

    if (featureKey) {
      const entitlements =
        await this.entitlementsService.getEffectiveEntitlements(organizationId);

      if (!entitlements.has(featureKey)) return false;

      const row = await this.repository.getModule(organizationId, moduleType);

      // Absent row defaults to enabled for entitled tenants.
      return row?.is_enabled !== false;
    }

    // Legacy path: no catalog key mapped — original strict-false default.
    const row = await this.repository.getModule(organizationId, moduleType);

    return row?.is_enabled === true;
  }

  /**
   * Space-level toggle (`space_modules`), independent of the tenant toggle
   * above: callers check both. A missing row means disabled, and archived
   * spaces never count. Lives here because every RP service already injects
   * this one, so no new module import (or cycle) is needed.
   */
  getEnabledSpaceIds(
    organizationId: string,
    moduleType: string,
    spaceIds?: string[],
  ): Promise<string[]> {
    return this.repository.listEnabledSpaceIds(
      organizationId,
      moduleType,
      spaceIds,
    );
  }

  async isSpaceModuleEnabled(
    organizationId: string,
    spaceId: string,
    moduleType: string,
  ): Promise<boolean> {
    return (
      (await this.getEnabledSpaceIds(organizationId, moduleType, [spaceId]))
        .length > 0
    );
  }

  /**
   * Raw legacy value — does NOT consult entitlements. Use when you specifically
   * need the tenant admin's stored toggle state (e.g. the tenant-config
   * settings UI showing what the admin has saved, regardless of whether the
   * license currently grants the underlying feature).
   *
   * Returns:
   *   - true  iff row exists with is_enabled = true
   *   - false otherwise (no row, or row with is_enabled = false)
   */
  async isLegacyEnabled(
    organizationId: string,
    moduleType: OrganizationModuleType,
  ): Promise<boolean> {
    const row = await this.repository.getModule(organizationId, moduleType);

    return row?.is_enabled === true;
  }

  listForOrg(organizationId: string): Promise<OrganizationModuleRow[]> {
    return this.repository.listForOrg(organizationId);
  }

  async setEnabled(
    organizationId: string,
    moduleType: string,
    enabled: boolean,
    userId: string,
  ): Promise<OrganizationModuleRow> {
    this.assertAllowedModule(moduleType);
    if (
      !(await this.permissionsService.isAdminOrOwner(userId, organizationId))
    ) {
      throw new ForbiddenException(
        'Only organization admins or owners can update modules',
      );
    }

    // Entitlement gate: allow turning OFF unconditionally (tenant admin opt-out
    // works regardless of license). Reject turning ON when the tenant isn't
    // entitled — structured 403 so the frontend can branch on `code`.
    if (enabled) {
      const featureKey = MODULE_TYPE_TO_FEATURE_KEY[moduleType];

      if (featureKey) {
        const entitlements =
          await this.entitlementsService.getEffectiveEntitlements(
            organizationId,
          );

        if (!entitlements.has(featureKey)) {
          throw new ForbiddenException({
            code: 'FEATURE_NOT_ENTITLED',
            feature_key: featureKey,
            message: `Cannot enable '${moduleType}': feature is not included in your license.`,
          });
        }
      }
    }

    const row = await this.repository.upsert(
      organizationId,
      moduleType,
      enabled,
      userId,
    );

    await this.auditLogs.createLog(organizationId, userId, {
      entity_type: 'organization_module',
      entity_id: row.id,
      action: 'update',
      changes: { module_type: moduleType, is_enabled: enabled },
    });

    return row;
  }
}
