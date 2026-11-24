/**
 * @fileoverview Owner/admin configuration of SAML connections, verified email
 * domains, SCIM tokens and Require SSO (XE-T346).
 * @module src/sso/sso-admin.service
 */

import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { domainToASCII } from 'node:url';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { EntitlementsService } from '../licensing/entitlements.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  AddSsoDomainDto,
  CreateScimTokenDto,
  CreateSsoConnectionDto,
  UpdateSsoConnectionDto,
  UpdateSsoDomainDto,
  UpdateSsoSettingsDto,
} from './sso-admin.dto';
import { SsoAccountsService } from './sso-accounts.service';
import { getSamlSpBaseUrl, getSamlSpUrls, getScimBaseUrl } from './sso-urls';

export interface ISsoConnection {
  id: string;
  display_name: string;
  idp_entity_id: string;
  idp_sso_url: string;
  idp_certs: string[];
  is_enabled: boolean;
  jit_enabled: boolean;
  /** The user who last set the trust material is currently an owner. */
  owner_trusted: boolean;
  created_at: string;
  updated_at: string;
  sp_entity_id: string;
  acs_url: string;
  metadata_url: string;
}

export interface ISsoDomain {
  id: string;
  domain: string;
  connection_id: string | null;
  verified_at: string | null;
  txt_record_name: string;
  txt_record_value: string;
  created_at: string;
}

export interface IScimToken {
  id: string;
  label: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  } | null;
  creator_is_member: boolean;
}

export interface ISsoSettings {
  require_sso: boolean;
  scim_base_url: string;
}

interface ISsoConnectionRow {
  id: string;
  display_name: string;
  idp_entity_id: string;
  idp_sso_url: string;
  idp_certs: string[] | null;
  is_enabled: boolean;
  jit_enabled: boolean;
  trust_updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ISsoDomainRow {
  id: string;
  domain: string;
  connection_id: string | null;
  verification_token: string;
  verified_at: string | null;
  created_at: string;
}

interface IScimTokenRow extends Omit<
  IScimToken,
  'created_by' | 'creator_is_member'
> {
  creator: IScimToken['created_by'];
}

/** A pending change whose effect on Require SSO must be checked first. */
interface ISsoReadinessChange {
  disabledConnectionId?: string;
  removedDomainId?: string;
  rebound?: { domainId: string; connectionId: string | null };
}

interface ISupabaseError {
  code?: string;
  message: string;
}

type SsoAuditEntity =
  | 'sso_connection'
  | 'sso_domain'
  | 'scim_token'
  | 'sso_settings';

const CONNECTION_COLUMNS =
  'id, display_name, idp_entity_id, idp_sso_url, idp_certs, is_enabled, jit_enabled, trust_updated_by, created_at, updated_at';
const DOMAIN_COLUMNS =
  'id, domain, connection_id, verification_token, verified_at, created_at';
const TOKEN_COLUMNS =
  'id, label, token_prefix, created_at, last_used_at, revoked_at, creator:users!scim_tokens_created_by_fkey(id, email, first_name, last_name)';

/** Mirrors the `sso_domains_domain_format` CHECK constraint. */
const DOMAIN_FORMAT =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Fields whose change decides whose SAML assertions are trusted. */
const TRUST_FIELDS = ['idp_entity_id', 'idp_sso_url', 'idp_certs'] as const;

/**
 * Validates each certificate and returns it as PEM with BEGIN/END lines.
 *
 * @throws {BadRequestException} `invalid_certificate`
 */
function normalizeCertificates(certs: string[]): string[] {
  return certs.map((cert) => {
    const body = cert
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----`;

    try {
      void new X509Certificate(pem);
    } catch {
      throw new BadRequestException('invalid_certificate');
    }

    return pem;
  });
}

/**
 * Lowercase ASCII (punycode) FQDN without a trailing dot.
 *
 * @throws {BadRequestException} `invalid_domain`
 */
function normalizeDomain(input: string): string {
  const domain = domainToASCII(input.trim().toLowerCase().replace(/\.$/, ''));

  if (!DOMAIN_FORMAT.test(domain)) {
    throw new BadRequestException('invalid_domain');
  }

  return domain;
}

function toDomain(row: ISsoDomainRow): ISsoDomain {
  return {
    id: row.id,
    domain: row.domain,
    connection_id: row.connection_id,
    verified_at: row.verified_at,
    txt_record_name: `_xisuite-sso.${row.domain}`,
    txt_record_value: `xisuite-sso=${row.verification_token}`,
    created_at: row.created_at,
  };
}

function toScimToken(row: IScimTokenRow, creatorIsMember: boolean): IScimToken {
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    created_by: row.creator ?? null,
    creator_is_member: creatorIsMember,
  };
}

/**
 * SSO administration for the caller's active workspace.
 *
 * Every method first requires the caller's membership role in the active org
 * to be owner or admin (Q13), and every query is scoped to that org: the
 * service-role client bypasses RLS, so `.eq('organization_id')` is the only
 * tenant boundary. Certificates and token plaintext are never audited.
 */
@Injectable()
export class SsoAdminService {
  private readonly logger = new Logger(SsoAdminService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService,
    private readonly accounts: SsoAccountsService,
    private readonly auditLogs: AuditLogsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Connections ─────────────────────────────────────────────────────────

  async listConnections(actor: RequestUser): Promise<ISsoConnection[]> {
    const orgId = this.assertManager(actor);
    const { data, error } = await this.client
      .from('sso_connections')
      .select(CONNECTION_COLUMNS)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true });

    if (error) this.fail('list SSO connections', error);

    return Promise.all(
      (data as ISsoConnectionRow[]).map((row) => this.toConnection(orgId, row)),
    );
  }

  async createConnection(
    actor: RequestUser,
    dto: CreateSsoConnectionDto,
  ): Promise<ISsoConnection> {
    const orgId = this.assertManager(actor);
    const idpCerts = normalizeCertificates(dto.idp_certs);
    const { data, error } = await this.client
      .from('sso_connections')
      .insert({
        organization_id: orgId,
        display_name: dto.display_name.trim(),
        idp_entity_id: dto.idp_entity_id.trim(),
        idp_sso_url: dto.idp_sso_url.trim(),
        idp_certs: idpCerts,
        is_enabled: dto.is_enabled ?? false,
        jit_enabled: dto.jit_enabled ?? false,
        created_by: actor.userId,
        updated_by: actor.userId,
        trust_updated_by: actor.userId,
      })
      .select(CONNECTION_COLUMNS)
      .single();

    if (error)
      this.fail('create the SSO connection', error, 'idp_entity_id_taken');

    const row = data as ISsoConnectionRow;

    await this.audit(orgId, 'sso_connection', row.id, 'create', actor, {
      display_name: row.display_name,
      idp_entity_id: row.idp_entity_id,
      idp_sso_url: row.idp_sso_url,
      cert_count: row.idp_certs?.length ?? 0,
      is_enabled: row.is_enabled,
      jit_enabled: row.jit_enabled,
    });

    return this.toConnection(orgId, row);
  }

  async updateConnection(
    actor: RequestUser,
    id: string,
    dto: UpdateSsoConnectionDto,
  ): Promise<ISsoConnection> {
    const orgId = this.assertManager(actor);
    const onlyDisables =
      dto.is_enabled === false &&
      Object.entries(dto).every(
        ([key, value]) => key === 'is_enabled' || value == null,
      );

    // Read-only grace (Q8): an unlicensed org may still disable a connection.
    if (!onlyDisables) await this.assertSsoEntitled(orgId);

    const current = await this.getConnection(orgId, id);
    const patch: Record<string, unknown> = {};

    if (dto.display_name != null) patch.display_name = dto.display_name.trim();
    if (dto.idp_entity_id != null) {
      patch.idp_entity_id = dto.idp_entity_id.trim();
    }
    if (dto.idp_sso_url != null) patch.idp_sso_url = dto.idp_sso_url.trim();
    if (dto.idp_certs != null) {
      patch.idp_certs = normalizeCertificates(dto.idp_certs);
    }
    if (dto.is_enabled != null) patch.is_enabled = dto.is_enabled;
    if (dto.jit_enabled != null) patch.jit_enabled = dto.jit_enabled;

    const changedFields = Object.keys(patch);
    const trustChanged =
      (patch.idp_entity_id !== undefined &&
        patch.idp_entity_id !== current.idp_entity_id) ||
      (patch.idp_sso_url !== undefined &&
        patch.idp_sso_url !== current.idp_sso_url) ||
      (patch.idp_certs !== undefined &&
        JSON.stringify(patch.idp_certs) !== JSON.stringify(current.idp_certs));
    const actorIsOwner =
      actor.memberships?.find((m) => m.organizationId === orgId)?.role ===
      'owner';

    // Changing trust material always records who did it. An owner re-saving
    // unchanged trust material vouches for a connection an admin configured
    // (owner-login protection); an admin re-saving it unchanged keeps the vouch.
    if (
      trustChanged ||
      (actorIsOwner && TRUST_FIELDS.some((field) => dto[field] != null))
    ) {
      patch.trust_updated_by = actor.userId;
    }

    if (current.is_enabled && dto.is_enabled === false) {
      await this.assertRequireSsoKept(
        orgId,
        { disabledConnectionId: id },
        'require_sso_last_connection',
      );
    }

    const { data, error } = await this.client
      .from('sso_connections')
      .update({ ...patch, updated_by: actor.userId })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select(CONNECTION_COLUMNS)
      .single();

    if (error)
      this.fail('update the SSO connection', error, 'idp_entity_id_taken');

    const row = data as ISsoConnectionRow;

    await this.audit(orgId, 'sso_connection', id, 'update', actor, {
      changed_fields: changedFields,
      trust_updated: 'trust_updated_by' in patch,
      display_name: row.display_name,
      idp_entity_id: row.idp_entity_id,
      is_enabled: row.is_enabled,
      jit_enabled: row.jit_enabled,
    });

    return this.toConnection(orgId, row);
  }

  async deleteConnection(
    actor: RequestUser,
    id: string,
  ): Promise<{ id: string }> {
    const orgId = this.assertManager(actor);
    const current = await this.getConnection(orgId, id);

    if (current.is_enabled) {
      await this.assertRequireSsoKept(
        orgId,
        { disabledConnectionId: id },
        'require_sso_last_connection',
      );
    }

    const { error } = await this.client
      .from('sso_connections')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId);

    if (error) this.fail('delete the SSO connection', error);

    await this.audit(orgId, 'sso_connection', id, 'delete', actor, {
      display_name: current.display_name,
      idp_entity_id: current.idp_entity_id,
    });

    return { id };
  }

  // ── Domains ─────────────────────────────────────────────────────────────

  async listDomains(actor: RequestUser): Promise<ISsoDomain[]> {
    const orgId = this.assertManager(actor);
    const { data, error } = await this.client
      .from('sso_domains')
      .select(DOMAIN_COLUMNS)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true });

    if (error) this.fail('list SSO domains', error);

    return (data as ISsoDomainRow[]).map(toDomain);
  }

  async addDomain(
    actor: RequestUser,
    dto: AddSsoDomainDto,
  ): Promise<ISsoDomain> {
    const orgId = this.assertManager(actor);
    const domain = normalizeDomain(dto.domain);
    const connectionId = dto.connection_id ?? null;

    if (connectionId) await this.assertConnectionInOrg(orgId, connectionId);

    const { data, error } = await this.client
      .from('sso_domains')
      .insert({
        organization_id: orgId,
        domain,
        connection_id: connectionId,
        verification_token: randomBytes(16).toString('hex'),
        created_by: actor.userId,
      })
      .select(DOMAIN_COLUMNS)
      .single();

    if (error) this.fail('add the SSO domain', error, 'domain_already_added');

    const row = data as ISsoDomainRow;

    await this.audit(orgId, 'sso_domain', row.id, 'create', actor, {
      domain,
      connection_id: connectionId,
    });

    return toDomain(row);
  }

  async updateDomain(
    actor: RequestUser,
    id: string,
    dto: UpdateSsoDomainDto,
  ): Promise<ISsoDomain> {
    const orgId = this.assertManager(actor);
    const current = await this.getDomain(orgId, id);
    const connectionId = dto.connection_id ?? null;

    if (connectionId) await this.assertConnectionInOrg(orgId, connectionId);

    if (current.verified_at) {
      await this.assertRequireSsoKept(
        orgId,
        { rebound: { domainId: id, connectionId } },
        'require_sso_last_domain',
      );
    }

    const { data, error } = await this.client
      .from('sso_domains')
      .update({ connection_id: connectionId })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select(DOMAIN_COLUMNS)
      .single();

    if (error) this.fail('update the SSO domain', error);

    await this.audit(orgId, 'sso_domain', id, 'update', actor, {
      domain: current.domain,
      connection_id: connectionId,
    });

    return toDomain(data as ISsoDomainRow);
  }

  /**
   * Marks the domain verified once `_xisuite-sso.<domain>` publishes
   * `xisuite-sso=<token>`. Idempotent for an already verified domain.
   */
  async verifyDomain(actor: RequestUser, id: string): Promise<ISsoDomain> {
    const orgId = this.assertManager(actor);
    const current = await this.getDomain(orgId, id);

    if (current.verified_at) return toDomain(current);

    if (!current.connection_id) {
      throw new BadRequestException('domain_not_bound');
    }

    const records = await this.resolveTxt(
      `_xisuite-sso.${current.domain}`,
    ).catch(() => [] as string[][]);
    const expected = `xisuite-sso=${current.verification_token}`;

    // A TXT record may be split into 255-byte chunks; join them back.
    if (!records.some((chunks) => chunks.join('') === expected)) {
      throw new BadRequestException('domain_verification_failed');
    }

    const { data, error } = await this.client
      .from('sso_domains')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select(DOMAIN_COLUMNS)
      .single();

    if (error) {
      this.fail('verify the SSO domain', error, 'domain_verified_elsewhere');
    }

    await this.audit(orgId, 'sso_domain', id, 'update', actor, {
      domain: current.domain,
      verified: true,
    });

    return toDomain(data as ISsoDomainRow);
  }

  async deleteDomain(actor: RequestUser, id: string): Promise<{ id: string }> {
    const orgId = this.assertManager(actor);
    const current = await this.getDomain(orgId, id);

    if (current.verified_at) {
      await this.assertRequireSsoKept(
        orgId,
        { removedDomainId: id },
        'require_sso_last_domain',
      );
    }

    const { error } = await this.client
      .from('sso_domains')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId);

    if (error) this.fail('remove the SSO domain', error);

    await this.audit(orgId, 'sso_domain', id, 'delete', actor, {
      domain: current.domain,
    });

    return { id };
  }

  // ── SCIM tokens ─────────────────────────────────────────────────────────

  async listScimTokens(actor: RequestUser): Promise<IScimToken[]> {
    const orgId = this.assertManager(actor);
    const { data, error } = await this.client
      .from('scim_tokens')
      .select(TOKEN_COLUMNS)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (error) this.fail('list SCIM tokens', error);

    const rows = data as unknown as IScimTokenRow[];
    const creatorIds = [
      ...new Set(rows.flatMap((row) => (row.creator ? [row.creator.id] : []))),
    ];
    const memberIds = new Set<string>();

    if (creatorIds.length > 0) {
      const members = await this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', orgId)
        .in('user_id', creatorIds);

      if (members.error) this.fail('list SCIM token creators', members.error);

      for (const member of members.data as { user_id: string }[]) {
        memberIds.add(member.user_id);
      }
    }

    return rows.map((row) =>
      toScimToken(row, Boolean(row.creator && memberIds.has(row.creator.id))),
    );
  }

  /** Creates a token; the plaintext is returned here once and never stored. */
  async createScimToken(
    actor: RequestUser,
    dto: CreateScimTokenDto,
  ): Promise<{ token: string; scim_token: IScimToken }> {
    const orgId = this.assertManager(actor);
    const token = `xis_scim_${randomBytes(32).toString('base64url')}`;
    const tokenPrefix = token.slice(0, 12);
    const { data, error } = await this.client
      .from('scim_tokens')
      .insert({
        organization_id: orgId,
        label: dto.label.trim(),
        token_hash: createHash('sha256').update(token).digest('hex'),
        token_prefix: tokenPrefix,
        created_by: actor.userId,
      })
      .select(TOKEN_COLUMNS)
      .single();

    if (error) this.fail('create the SCIM token', error);

    const row = data as unknown as IScimTokenRow;

    await this.audit(orgId, 'scim_token', row.id, 'create', actor, {
      label: row.label,
      token_prefix: tokenPrefix,
    });

    return { token, scim_token: toScimToken(row, true) };
  }

  async revokeScimToken(
    actor: RequestUser,
    id: string,
  ): Promise<{ id: string }> {
    const orgId = this.assertManager(actor);
    const { data, error } = await this.client
      .from('scim_tokens')
      .select('id, label, token_prefix, revoked_at')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) this.fail('read the SCIM token', error);
    if (!data) throw new NotFoundException('scim_token_not_found');

    if (!data.revoked_at) {
      const revoked = await this.client
        .from('scim_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id)
        .eq('organization_id', orgId);

      if (revoked.error) this.fail('revoke the SCIM token', revoked.error);

      await this.audit(orgId, 'scim_token', id, 'delete', actor, {
        label: data.label,
        token_prefix: data.token_prefix,
        revoked: true,
      });
    }

    return { id };
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async getSettings(actor: RequestUser): Promise<ISsoSettings> {
    const orgId = this.assertManager(actor);

    return {
      require_sso: await this.isRequireSsoOn(orgId),
      scim_base_url: getScimBaseUrl(this.config),
    };
  }

  /**
   * Switching Require SSO off is always allowed (read-only grace). Switching
   * it on needs `feature_sso` plus an enabled connection with a verified
   * domain bound to it, so members always have a way to sign in.
   */
  async updateSettings(
    actor: RequestUser,
    dto: UpdateSsoSettingsDto,
  ): Promise<ISsoSettings> {
    const orgId = this.assertManager(actor);

    if (dto.require_sso) {
      await this.assertSsoEntitled(orgId);

      if (!(await this.isSsoReady(orgId))) {
        throw new ConflictException('require_sso_not_ready');
      }
    }

    const { error } = await this.client
      .from('sso_organization_settings')
      .upsert(
        {
          organization_id: orgId,
          require_sso: dto.require_sso,
          updated_by: actor.userId,
        },
        { onConflict: 'organization_id' },
      );

    if (error) this.fail('update SSO settings', error);

    await this.audit(orgId, 'sso_settings', orgId, 'update', actor, {
      require_sso: dto.require_sso,
    });

    return {
      require_sso: dto.require_sso,
      scim_base_url: getScimBaseUrl(this.config),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Returns the active org id when the caller is its owner or admin. The
   * membership role is used, never `RequestUser.role` (a display label).
   *
   * @throws {ForbiddenException} Otherwise, including custom-role holders
   */
  private assertManager(actor: RequestUser): string {
    const role = actor.memberships?.find(
      (membership) => membership.organizationId === actor.organizationId,
    )?.role;

    if (!actor.organizationId || (role !== 'owner' && role !== 'admin')) {
      throw new ForbiddenException(
        'Only workspace owners and admins can manage single sign-on',
      );
    }

    return actor.organizationId;
  }

  /** @throws {ForbiddenException} `FEATURE_NOT_ENTITLED`, FeatureGuard's shape */
  private async assertSsoEntitled(orgId: string): Promise<void> {
    const entitlements =
      await this.entitlements.getEffectiveEntitlements(orgId);

    if (!entitlements.has('feature_sso')) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_ENTITLED',
        message: 'Your plan does not include single sign-on',
        required_features: ['feature_sso'],
      });
    }
  }

  /** DNS lookup seam, stubbed by specs. */
  private resolveTxt(name: string): Promise<string[][]> {
    return dns.resolveTxt(name);
  }

  private async toConnection(
    orgId: string,
    row: ISsoConnectionRow,
  ): Promise<ISsoConnection> {
    const urls = getSamlSpUrls(getSamlSpBaseUrl(this.config), row.id);

    return {
      id: row.id,
      display_name: row.display_name,
      idp_entity_id: row.idp_entity_id,
      idp_sso_url: row.idp_sso_url,
      idp_certs: row.idp_certs ?? [],
      is_enabled: row.is_enabled,
      jit_enabled: row.jit_enabled,
      owner_trusted: await this.accounts.isCurrentOwner(
        orgId,
        row.trust_updated_by,
      ),
      created_at: row.created_at,
      updated_at: row.updated_at,
      sp_entity_id: urls.spEntityId,
      acs_url: urls.acsUrl,
      metadata_url: urls.metadataUrl,
    };
  }

  private async getConnection(
    orgId: string,
    id: string,
  ): Promise<ISsoConnectionRow> {
    const { data, error } = await this.client
      .from('sso_connections')
      .select(CONNECTION_COLUMNS)
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) this.fail('read the SSO connection', error);
    if (!data) throw new NotFoundException('sso_connection_not_found');

    return data as ISsoConnectionRow;
  }

  private async assertConnectionInOrg(
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('sso_connections')
      .select('id')
      .eq('id', connectionId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) this.fail('read the SSO connection', error);
    if (!data) throw new BadRequestException('invalid_connection');
  }

  private async getDomain(orgId: string, id: string): Promise<ISsoDomainRow> {
    const { data, error } = await this.client
      .from('sso_domains')
      .select(DOMAIN_COLUMNS)
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) this.fail('read the SSO domain', error);
    if (!data) throw new NotFoundException('sso_domain_not_found');

    return data as ISsoDomainRow;
  }

  private async isRequireSsoOn(orgId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('sso_organization_settings')
      .select('require_sso')
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) this.fail('read SSO settings', error);

    return data?.require_sso === true;
  }

  /**
   * True when at least one verified domain is bound to an enabled connection,
   * after applying `change`.
   */
  private async isSsoReady(
    orgId: string,
    change: ISsoReadinessChange = {},
  ): Promise<boolean> {
    const [connections, domains] = await Promise.all([
      this.client
        .from('sso_connections')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_enabled', true),
      this.client
        .from('sso_domains')
        .select('id, connection_id')
        .eq('organization_id', orgId)
        .not('verified_at', 'is', null),
    ]);

    if (connections.error) this.fail('check Require SSO', connections.error);
    if (domains.error) this.fail('check Require SSO', domains.error);

    const enabled = new Set(
      (connections.data as { id: string }[])
        .map((connection) => connection.id)
        .filter((id) => id !== change.disabledConnectionId),
    );
    const rebound = change.rebound;

    return (
      domains.data as { id: string; connection_id: string | null }[]
    ).some((domain) => {
      if (domain.id === change.removedDomainId) return false;

      const connectionId =
        rebound && domain.id === rebound.domainId
          ? rebound.connectionId
          : domain.connection_id;

      return connectionId !== null && enabled.has(connectionId);
    });
  }

  /**
   * While Require SSO is on, refuses a change that would leave members with no
   * SSO path into the workspace.
   *
   * @throws {ConflictException} `conflictCode`
   */
  private async assertRequireSsoKept(
    orgId: string,
    change: ISsoReadinessChange,
    conflictCode: string,
  ): Promise<void> {
    if (!(await this.isRequireSsoOn(orgId))) return;

    if (!(await this.isSsoReady(orgId, change))) {
      throw new ConflictException(conflictCode);
    }
  }

  private audit(
    orgId: string,
    entityType: SsoAuditEntity,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    actor: RequestUser,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.auditLogs.logSystemAction(orgId, entityType, entityId, action, {
      actor_user_id: actor.userId,
      ...changes,
    });
  }

  /**
   * Maps a Supabase error: 23505 to 409 `conflictCode` when given, CHECK
   * violations to 400, anything else to a logged 500.
   */
  private fail(
    action: string,
    error: ISupabaseError,
    conflictCode?: string,
  ): never {
    if (conflictCode && error.code === '23505') {
      throw new ConflictException(conflictCode);
    }

    if (error.code === '23514') throw new BadRequestException('invalid_input');

    this.logger.error(`Failed to ${action}: ${error.message}`);
    throw new InternalServerErrorException(`Failed to ${action}`);
  }
}
