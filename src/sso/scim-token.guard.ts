/**
 * @fileoverview Authenticates SCIM requests with a workspace SCIM bearer token
 * and attaches the token's organization to the request.
 * @module src/sso/scim-token.guard
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/** Verified SCIM caller context. The organization comes only from the token. */
export interface IScimContext {
  orgId: string;
  tokenId: string;
  /** `scim_tokens.created_by`; null once that user was deleted. */
  creatorUserId: string | null;
  /** Creator, else an owner of the org; recorded as the actor on group writes. */
  actorUserId: string;
}

export type ScimRequest = Request & { scim: IScimContext };

/**
 * Accepts `Authorization: Bearer xis_scim_…`, looks up its sha256 hash among
 * non-revoked `scim_tokens` and sets `req.scim`. Anything else is a 401.
 */
@Injectable()
export class ScimTokenGuard implements CanActivate {
  /** @private Logger instance scoped to this guard */
  private readonly logger = new Logger(ScimTokenGuard.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Service-role Supabase client
   */
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /**
   * @param {ExecutionContext} context - The current request context
   * @returns {Promise<boolean>} True when the token is valid
   * @throws {UnauthorizedException} When the token is missing, unknown or revoked
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScimRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];

    if (scheme?.toLowerCase() !== 'bearer' || !token?.startsWith('xis_scim_')) {
      throw new UnauthorizedException('Invalid SCIM token');
    }

    const client = this.supabaseAdmin.getClient();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const { data, error } = await client
      .from('scim_tokens')
      .select('id, organization_id, created_by')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (error) {
      this.logger.error(`SCIM token lookup failed: ${error.message}`);
      throw new InternalServerErrorException();
    }

    if (!data) throw new UnauthorizedException('Invalid SCIM token');

    const row = data as {
      id: string;
      organization_id: string;
      created_by: string | null;
    };
    const actorUserId =
      row.created_by ?? (await this.findOwner(row.organization_id));

    request.scim = {
      orgId: row.organization_id,
      tokenId: row.id,
      creatorUserId: row.created_by,
      actorUserId,
    };

    void client
      .from('scim_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .then(({ error: updateError }) => {
        if (updateError) {
          this.logger.warn(
            `SCIM token last_used_at update failed: ${updateError.message}`,
          );
        }
      });

    return true;
  }

  /** Every organization keeps at least one owner (enforced by a DB trigger). */
  private async findOwner(orgId: string): Promise<string> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .eq('role', 'owner')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const ownerId = (data as { user_id: string } | null)?.user_id;

    if (error || !ownerId) {
      this.logger.error(`No owner found for SCIM organization ${orgId}`);
      throw new InternalServerErrorException();
    }

    return ownerId;
  }
}
