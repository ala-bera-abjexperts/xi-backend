import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  OrganizationAuthProviderRepository,
  type OrganizationAuthProviderRow,
} from './organization-auth-provider.repository';

/** External SSO providers that can be toggled per-org. */
export const ALLOWED_AUTH_PROVIDERS = ['azure', 'keycloak'] as const;
export type AuthProviderType = (typeof ALLOWED_AUTH_PROVIDERS)[number];

/** Providers that are ONLY ever available on-premise (never in the SaaS build). */
export const ON_PREM_ONLY_PROVIDERS: ReadonlySet<AuthProviderType> = new Set([
  'keycloak',
]);

/**
 * On-premise deployment flag, evaluated at module-eval time. Mirrors the check
 * in `app.module.ts`. The SaaS build never sets `IS_ON_PREMISE`, so this is
 * `false` in cloud — the single source of truth that keeps Keycloak, and the
 * whole provider-toggle write path, off-premise-only.
 */
const IS_ON_PREMISE = ['true', '1', 'yes'].includes(
  (process.env.IS_ON_PREMISE || '').trim().toLowerCase(),
);

/**
 * Per-org external-SSO provider toggles (Azure / Keycloak) backing the
 * on-premise-only "Authentication" tab in Tenant Config.
 *
 * Cloud safety: writes are rejected entirely off-premise, and Keycloak is never
 * reported as enabled off-premise even if a stale row exists.
 */
@Injectable()
export class OrganizationAuthProvidersService {
  private readonly logger = new Logger(OrganizationAuthProvidersService.name);

  constructor(
    private readonly repository: OrganizationAuthProviderRepository,
    private readonly auditLogs: AuditLogsService,
    private readonly permissionsService: PermissionsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  /** True when this deployment runs on-premise. */
  get isOnPremise(): boolean {
    return IS_ON_PREMISE;
  }

  /**
   * Resolve the org whose toggles drive the (pre-auth) login page on-premise.
   * On-prem is single-tenant: prefer the pinned `ON_PREMISE_ORG_ID`, else the
   * sole organization. Returns `null` when it cannot be determined unambiguously
   * (e.g. multiple orgs with no pin) — callers then surface no SSO providers.
   */
  async resolveOnPremiseOrgId(): Promise<string | null> {
    const pinned = (process.env.ON_PREMISE_ORG_ID || '').trim();

    if (pinned) return pinned;

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .select('id')
      .limit(2);

    if (error) {
      this.logger.warn(
        `resolveOnPremiseOrgId: organizations lookup failed: ${error.message}`,
      );

      return null;
    }

    if (data && data.length === 1) return (data[0] as { id: string }).id;

    return null;
  }

  /**
   * Enabled + deployment-permitted providers for the on-premise login page,
   * resolving the org automatically. Returns `[]` off-premise or when the org
   * cannot be resolved.
   */
  async getAvailableProvidersForOnPremise(): Promise<AuthProviderType[]> {
    if (!IS_ON_PREMISE) return [];

    const orgId = await this.resolveOnPremiseOrgId();

    if (!orgId) return [];

    return this.getAvailableProviders(orgId);
  }

  assertAllowedProvider(
    provider: string,
  ): asserts provider is AuthProviderType {
    if (!ALLOWED_AUTH_PROVIDERS.includes(provider as AuthProviderType)) {
      throw new BadRequestException('Unknown auth provider');
    }
  }

  listForOrg(organizationId: string): Promise<OrganizationAuthProviderRow[]> {
    return this.repository.listForOrg(organizationId);
  }

  /**
   * Raw stored toggle for one provider. Absent row = disabled (default OFF).
   * Does NOT apply the on-premise gate — callers that surface provider
   * availability must additionally consult {@link isAvailable}.
   */
  async isEnabled(
    organizationId: string,
    provider: AuthProviderType,
  ): Promise<boolean> {
    const row = await this.repository.getProvider(organizationId, provider);

    return row?.is_enabled === true;
  }

  /**
   * A provider is AVAILABLE when it is enabled AND permitted in this deployment
   * mode (on-prem-only providers are never available in the SaaS build). This is
   * the authoritative check used by the public providers endpoint and the
   * authorize guard.
   */
  async isAvailable(
    organizationId: string,
    provider: AuthProviderType,
  ): Promise<boolean> {
    if (ON_PREM_ONLY_PROVIDERS.has(provider) && !IS_ON_PREMISE) return false;

    return this.isEnabled(organizationId, provider);
  }

  /**
   * Enabled + deployment-permitted providers for an org, used by the login page.
   */
  async getAvailableProviders(
    organizationId: string,
  ): Promise<AuthProviderType[]> {
    const rows = await this.repository.listForOrg(organizationId);
    const enabled = new Set(
      rows.filter((r) => r.is_enabled === true).map((r) => r.provider),
    );

    return ALLOWED_AUTH_PROVIDERS.filter(
      (p) =>
        enabled.has(p) && !(ON_PREM_ONLY_PROVIDERS.has(p) && !IS_ON_PREMISE),
    );
  }

  async setEnabled(
    organizationId: string,
    provider: string,
    enabled: boolean,
    userId: string,
  ): Promise<OrganizationAuthProviderRow> {
    // Cloud safety: the auth-provider toggle is an on-premise-only capability.
    // The tenant-config tab is hidden off-premise, but reject here too so a
    // crafted request can never persist a provider (esp. Keycloak) in the cloud.
    if (!IS_ON_PREMISE) {
      throw new ForbiddenException(
        'Auth-provider configuration is only available on-premise',
      );
    }

    this.assertAllowedProvider(provider);

    if (
      !(await this.permissionsService.isAdminOrOwner(userId, organizationId))
    ) {
      throw new ForbiddenException(
        'Only organization admins or owners can update auth providers',
      );
    }

    const row = await this.repository.upsert(
      organizationId,
      provider,
      enabled,
      userId,
    );

    await this.auditLogs.createLog(organizationId, userId, {
      entity_type: 'organization_auth_provider',
      entity_id: row.id,
      action: 'update',
      changes: { provider, is_enabled: enabled },
    });

    return row;
  }
}
