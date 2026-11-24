/**
 * @fileoverview Per-user File Explorer storage quota management.
 * Supports on-prem (owner-configured) and SaaS (license-driven) modes.
 * @module src/storage-config/storage-config.service
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../licensing/entitlements.service';
import { StorageConfigRepository } from './storage-config.repository';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type {
  OrgStorageConfigRow,
  UserStorageOverrideRow,
  UserStorageOverrideWithUsage,
} from './storage-config.repository';

export interface IOrgStorageConfigResponse extends OrgStorageConfigRow {
  isSaas: boolean;
  /** null when not in SaaS mode, or when the plan has no limit (unlimited). */
  licenseDefaultMb: number | null;
}

export interface IUserEffectiveQuotaResponse {
  userId: string;
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  source: 'override' | 'org_default' | 'hardcoded';
}

@Injectable()
export class StorageConfigService {
  private static readonly FALLBACK_QUOTA_BYTES = 5_368_709_120; // 5 GB

  constructor(
    private readonly repo: StorageConfigRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Get org storage config for owner UI. Includes SaaS mode detection and
   * the license-plan default quota (MB) when applicable.
   */
  async getOrgConfig(user: RequestUser): Promise<IOrgStorageConfigResponse> {
    const orgId = user.organizationId;
    const isSaas = await this.repo.isOrgSaaS(orgId);
    const config = await this.repo.getOrgConfig(orgId);

    let licenseDefaultMb: number | null = null;

    if (isSaas) {
      const ents = await this.entitlements.getEffectiveEntitlements(orgId);

      // 'limit_storage_mb' is the catalog's storage-limit key (feature-catalog.ts).
      // The previous read used 'limit_storage_per_user_mb', which is not in the
      // catalog, so getLimit() always returned null and the license default was
      // silently dropped. The comment describing that bug outlived the bug.
      licenseDefaultMb = ents.getLimit('limit_storage_mb');
    }

    const base = config ?? {
      id: '',
      organization_id: orgId,
      default_quota_bytes: StorageConfigService.FALLBACK_QUOTA_BYTES,
      updated_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return { ...base, isSaas, licenseDefaultMb };
  }

  /**
   * Update the org-level default per-user quota. Blocked in SaaS mode — the
   * license plan controls the default there.
   */
  async updateOrgConfig(
    user: RequestUser,
    defaultQuotaBytes: number,
  ): Promise<IOrgStorageConfigResponse> {
    const orgId = user.organizationId;
    const isSaas = await this.repo.isOrgSaaS(orgId);

    if (isSaas) {
      throw new ForbiddenException(
        'Default quota is controlled by your license plan in SaaS mode. Assign per-user expanded storage instead.',
      );
    }

    await this.repo.upsertOrgConfig(orgId, defaultQuotaBytes, user.userId);

    return this.getOrgConfig(user);
  }

  /** List all users who have per-user storage overrides, including used bytes. */
  async listUserOverrides(
    user: RequestUser,
  ): Promise<UserStorageOverrideWithUsage[]> {
    return this.repo.listUserOverrides(user.organizationId);
  }

  /** Upsert a per-user storage quota override. */
  async setUserOverride(
    user: RequestUser,
    targetUserId: string,
    quotaBytes: number,
    overrideSource: 'admin' | 'license',
    licensePlanKey?: string,
  ): Promise<UserStorageOverrideRow> {
    return this.repo.upsertUserOverride(
      user.organizationId,
      targetUserId,
      quotaBytes,
      overrideSource,
      licensePlanKey,
      user.userId,
    );
  }

  /**
   * Remove a per-user storage quota override, reverting user to the org default.
   * Idempotent — does NOT throw if no override exists.
   */
  async removeUserOverride(
    user: RequestUser,
    targetUserId: string,
  ): Promise<void> {
    await this.repo.deleteUserOverride(user.organizationId, targetUserId);
  }

  /** Get the effective quota + used bytes for the calling user. */
  async getMyQuota(user: RequestUser): Promise<IUserEffectiveQuotaResponse> {
    const { quota, used } = await this.repo.getUserQuota(
      user.organizationId,
      user.userId,
    );
    const remaining = quota - used;

    // Determine source
    const orgId = user.organizationId;
    const userId = user.userId;
    const overrideExists = await this._hasOverride(orgId, userId);
    const configExists = await this.repo.getOrgConfig(orgId);

    let source: 'override' | 'org_default' | 'hardcoded';

    if (overrideExists) {
      source = 'override';
    } else if (configExists) {
      source = 'org_default';
    } else {
      source = 'hardcoded';
    }

    return {
      userId,
      quotaBytes: quota,
      usedBytes: used,
      remainingBytes: remaining,
      source,
    };
  }

  /**
   * Called by FileExplorerService before allowing an upload.
   * Throws PayloadTooLargeException (handled upstream) if quota exceeded.
   */
  async checkUploadAllowed(
    orgId: string,
    userId: string,
    newFileBytes: number,
  ): Promise<{
    allowed: boolean;
    quota: number;
    used: number;
    remaining: number;
  }> {
    return this.repo.checkUploadAllowed(orgId, userId, newFileBytes);
  }

  private async _hasOverride(orgId: string, userId: string): Promise<boolean> {
    const overrides = await this.repo.listUserOverrides(orgId);

    return overrides.some((o) => o.user_id === userId);
  }
}
