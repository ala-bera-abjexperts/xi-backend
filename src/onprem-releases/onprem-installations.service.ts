/**
 * @fileoverview Managing on-prem installations from the cloud: create, list,
 * activate/deactivate, rotate the activation code, reset the bound box, and
 * issue offline licence files. Shared by the partner portal (scoped to the
 * partner's own installs) and the super admin (everything, plus direct
 * customers with no partner).
 * @module onprem-releases/onprem-installations.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  CreateOnpremInstallDto,
  UpdateOnpremInstallDto,
} from './dto/onprem-installations.dto';
import {
  hashActivationCode,
  OnpremLicenseService,
} from './onprem-license.service';

/** Who is acting: a partner (only its own installs) or the platform. */
export type OnpremScope =
  | { kind: 'partner'; partnerOrgId: string }
  | { kind: 'super_admin' };

const TABLE = 'partner_onprem_installations';

/** Columns safe to return. Never the code or its hash. */
const PUBLIC_COLUMNS =
  'id, organization_id, organization_license_id, customer_id, customer_organization_id, status, mode, activated_at, last_heartbeat_at, last_seen_version, host_info, last_usage, license_expires_at, instance_fingerprint, activation_code, metadata, created_at, updated_at';

interface InstallRow {
  id: string;
  organization_id: string | null;
  organization_license_id: string;
  customer_organization_id: string;
  activation_code?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** A readable, unambiguous code: XIS-XXXX-XXXX-XXXX-XXXX (80 bits). */
function newActivationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';

  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }

  return `XIS-${out}`;
}

@Injectable()
export class OnpremInstallationsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly license: OnpremLicenseService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(scope: OnpremScope) {
    let query = this.client
      .from(TABLE)
      .select(
        `${PUBLIC_COLUMNS}, organization_licenses(label, status, ends_at, deployment_type)`,
      )
      .order('created_at', { ascending: false })
      .limit(500);

    if (scope.kind === 'partner') {
      query = query.eq('organization_id', scope.partnerOrgId);
    }

    const { data, error } = await query;

    if (error) throw new InternalServerErrorException(error.message);

    const rows = (data ?? []) as unknown as InstallRow[];
    const names = await this.orgNames([
      ...rows.map((r) => r.customer_organization_id),
      ...rows.map((r) => r.organization_id).filter((v): v is string => !!v),
    ]);

    return rows.map((r) => this.present(r, names));
  }

  /**
   * Creates an installation on an on-prem licence. The activation code is
   * returned ONCE (only its hash is stored); after that it can only be rotated.
   */
  async create(
    scope: OnpremScope,
    actorId: string,
    dto: CreateOnpremInstallDto,
  ) {
    const { data: licence, error } = await this.client
      .from('organization_licenses')
      .select('id, organization_id, partner_id, deployment_type, status')
      .eq('id', dto.organization_license_id)
      .maybeSingle();

    if (error) throw new BadRequestException('Failed to validate licence');

    const lic = licence as {
      id: string;
      organization_id: string;
      partner_id: string | null;
      deployment_type: string | null;
    } | null;

    // A partner may only install on licences it sold; scope by partner_id
    // (organization_id on a licence is the CUSTOMER org).
    if (
      !lic ||
      (scope.kind === 'partner' && lic.partner_id !== scope.partnerOrgId)
    ) {
      throw new BadRequestException('Licence not found');
    }

    if (lic.deployment_type !== 'onprem') {
      throw new BadRequestException(
        'This is a cloud licence. Installations need an on-premise licence.',
      );
    }

    const partnerOrgId =
      scope.kind === 'partner' ? scope.partnerOrgId : lic.partner_id;
    const customerId =
      dto.customer_id ??
      (await this.partnerCustomerFor(partnerOrgId, lic.organization_id));

    if (dto.customer_id && partnerOrgId) {
      const { data: customer } = await this.client
        .from('partner_customers')
        .select('id')
        .eq('id', dto.customer_id)
        .eq('organization_id', partnerOrgId)
        .maybeSingle();

      if (!customer) throw new BadRequestException('Customer not found');
    }

    const code = newActivationCode();
    const { data, error: insertError } = await this.client
      .from(TABLE)
      .insert({
        organization_id: partnerOrgId,
        organization_license_id: lic.id,
        customer_organization_id: lic.organization_id,
        customer_id: customerId,
        mode: dto.mode ?? 'connected',
        status: 'pending',
        activation_code: null,
        activation_code_hash: hashActivationCode(code),
        // Last 4 characters only, so admins can tell which code a server
        // uses (the server shows the same ending). Never the code itself.
        metadata: { activation_code_hint: code.slice(-4) },
        created_by: actorId,
        updated_by: actorId,
      })
      .select(PUBLIC_COLUMNS)
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        throw new ConflictException('This licence already has an installation');
      }
      throw new InternalServerErrorException(insertError.message);
    }

    return {
      ...this.present(data as unknown as InstallRow, new Map()),
      activation_code: code,
    };
  }

  async update(
    scope: OnpremScope,
    actorId: string,
    id: string,
    dto: UpdateOnpremInstallDto,
  ) {
    const row = await this.loadScoped(scope, id);
    const patch: Record<string, unknown> = {
      status: dto.status,
      updated_by: actorId,
    };

    if (dto.status === 'active' && !row.activated_at) {
      patch.activated_at = new Date().toISOString();
    }

    return this.write(id, patch);
  }

  /** New code (shown once); the old one stops working at the box's next check-in. */
  async rotateCode(scope: OnpremScope, actorId: string, id: string) {
    const current = await this.loadScoped(scope, id);
    const code = newActivationCode();
    const row = await this.write(id, {
      activation_code: null,
      activation_code_hash: hashActivationCode(code),
      metadata: {
        ...(current.metadata ?? {}),
        activation_code_hint: code.slice(-4),
      },
      updated_by: actorId,
    });

    return { ...row, activation_code: code };
  }

  /** Forget the bound box (server replaced). The next box to check in binds. */
  async resetFingerprint(scope: OnpremScope, actorId: string, id: string) {
    await this.loadScoped(scope, id);

    return this.write(id, { instance_fingerprint: null, updated_by: actorId });
  }

  async offlineLicense(scope: OnpremScope, id: string, request: unknown) {
    const row = await this.loadScoped(scope, id);

    return this.license.issueOffline({ id: row.id }, request);
  }

  private async loadScoped(
    scope: OnpremScope,
    id: string,
  ): Promise<InstallRow> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(PUBLIC_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    const row = data as unknown as InstallRow | null;

    if (
      !row ||
      (scope.kind === 'partner' && row.organization_id !== scope.partnerOrgId)
    ) {
      throw new NotFoundException('Installation not found');
    }

    return row;
  }

  private async write(id: string, patch: Record<string, unknown>) {
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .select(PUBLIC_COLUMNS)
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    return this.present(data as unknown as InstallRow, new Map());
  }

  private async partnerCustomerFor(
    partnerOrgId: string | null,
    customerOrgId: string,
  ): Promise<string | null> {
    if (!partnerOrgId) return null;

    const { data } = await this.client
      .from('partner_customers')
      .select('id')
      .eq('organization_id', partnerOrgId)
      .eq('customer_organization_id', customerOrgId)
      .limit(1)
      .maybeSingle();

    return (data as { id: string } | null)?.id ?? null;
  }

  private async orgNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].filter(Boolean);
    const names = new Map<string, string>();

    if (unique.length === 0) return names;

    const { data } = await this.client
      .from('organizations')
      .select('id, name')
      .in('id', unique);

    for (const o of (data ?? []) as { id: string; name: string }[]) {
      names.set(o.id, o.name);
    }

    return names;
  }

  /**
   * Never return a stored code: a legacy plaintext code is masked to its last
   * four characters, new installs only ever had a hash.
   */
  private present(row: InstallRow, names: Map<string, string>) {
    const { activation_code: legacyCode, metadata, ...rest } = row;
    const hint =
      typeof metadata?.activation_code_hint === 'string'
        ? metadata.activation_code_hint
        : legacyCode?.slice(-4);

    return {
      ...rest,
      activation_code: null as string | null,
      activation_code_hint: hint ? `…${hint}` : null,
      customer_organization_name:
        names.get(row.customer_organization_id) ?? null,
      partner_name: row.organization_id
        ? (names.get(row.organization_id) ?? null)
        : null,
    };
  }
}
