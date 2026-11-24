import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type {
  PasskeySessionAssuranceInput,
  PasskeySessionAssuranceReader,
} from './passkey-session-assurance.port';

type VerifiedClaims = {
  sub?: unknown;
  session_id?: unknown;
  amr?: unknown;
};

@Injectable()
export class PasskeySessionAssuranceService implements PasskeySessionAssuranceReader {
  private readonly logger = new Logger(PasskeySessionAssuranceService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  async isSessionAssured(
    input: PasskeySessionAssuranceInput,
  ): Promise<boolean> {
    const claimsResult = await this.supabaseAdmin
      .getClient()
      .auth.getClaims(input.accessToken);

    if (claimsResult.error || !claimsResult.data?.claims) return false;

    const claims = claimsResult.data.claims as unknown as VerifiedClaims;
    if (
      claims.sub !== input.authUserId ||
      claims.session_id !== input.sessionId ||
      !hasExactPasskeyAmr(claims.amr)
    ) {
      return false;
    }

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('auth_session_assurance')
      .select('session_id')
      .eq('session_id', input.sessionId)
      .eq('auth_user_id', input.authUserId)
      .eq('authentication_method', 'passkey')
      .eq('user_verified', true)
      .eq('risk_level', 'low')
      .eq('step_up_required', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error) {
      this.logger.warn(`passkey assurance lookup failed: ${error.message}`);
      return false;
    }

    return Boolean(data);
  }

  async countVerifiedPasskeys(authUserId: string): Promise<number> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .auth.admin.passkey.listPasskeys({ userId: authUserId });

    if (error) {
      throw new Error(`Passkey count failed: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  async revokeTrustedDevices(authUserId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabaseAdmin
      .getClient()
      .from('auth_trusted_devices')
      .update({ revoked_at: now, updated_at: now })
      .eq('auth_user_id', authUserId)
      .is('revoked_at', null);

    if (error) {
      throw new Error(`Trusted-device revocation failed: ${error.message}`);
    }

    await this.supabaseAdmin
      .getClient()
      .from('auth_security_events')
      .insert({
        auth_user_id: authUserId,
        event_type: 'trusted_device_revoked',
        authentication_method: 'password',
        reason_codes: ['password_changed'],
        metadata: {},
      });
  }
}

function hasExactPasskeyAmr(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  return value.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { method?: unknown }).method === 'passkey',
  );
}
