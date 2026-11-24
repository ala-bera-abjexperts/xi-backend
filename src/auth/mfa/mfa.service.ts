/**
 * @fileoverview MFA (TOTP) service that wraps `supabase.auth.mfa.*` operations.
 * Operates against a per-request user-scoped Supabase client because Supabase MFA
 * methods require the user's access token to identify whose factors are being
 * managed; the admin/service-role client cannot enroll a factor on behalf of a user.
 *
 * @module src/auth/mfa/mfa.service
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  deriveSessionMfaState,
  getSessionAssuranceTokenPayload,
  normalizeAuthenticationMethods,
} from './session-assurance.util';
import {
  PASSKEY_SESSION_ASSURANCE,
  type PasskeySessionAssuranceReader,
} from '../passkeys/passkey-session-assurance.port';

/**
 * Token bundle returned after a successful MFA verify.
 */
export interface MfaVerifyResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'bearer';
}

/**
 * Result returned by enroll — the QR code + secret are shown to the user once
 * during enrollment so they can scan it into their authenticator app.
 */
export interface MfaEnrollResult {
  factorId: string;
  type: 'totp';
  friendlyName: string | null;
  qrCode: string;
  secret: string;
  uri: string;
}

/**
 * Result returned by challenge.
 */
export interface MfaChallengeResult {
  challengeId: string;
  expiresAt: number;
}

/**
 * Result returned by listFactors.
 */
export interface MfaFactor {
  id: string;
  factorType: string;
  friendlyName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

type AuthUserFactor = {
  id?: string;
  factor_type?: string;
  status?: string;
};

/**
 * MFA service.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(PASSKEY_SESSION_ASSURANCE)
    private readonly passkeySessionAssurance?: PasskeySessionAssuranceReader,
  ) {}

  /**
   * Builds a per-request Supabase client bound to the caller's access token.
   * Required because mfa.* methods are scoped to the authenticated user.
   */
  private clientFor(accessToken: string): SupabaseClient {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');
    if (!url || !anonKey) {
      throw new Error('Supabase URL/anonKey not configured');
    }
    return createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }) as SupabaseClient;
  }

  /**
   * Enrolls a new TOTP factor for the user identified by the access token.
   *
   * @param {string} accessToken - The user's current access token (aal1)
   * @param {string} [friendlyName] - Optional label for the factor
   * @returns {Promise<MfaEnrollResult>} QR code, secret, and factor ID
   */
  async enroll(
    accessToken: string,
    friendlyName?: string,
  ): Promise<MfaEnrollResult> {
    await this.assertRecentTotpForFactorManagement(accessToken);

    const client = this.clientFor(accessToken);
    const { data, error } = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName,
    });

    if (error || !data) {
      this.logger.warn(`MFA enroll failed: ${error?.message}`);
      throw new BadRequestException(error?.message || 'MFA enroll failed');
    }

    return {
      factorId: data.id,
      type: 'totp',
      friendlyName: data.friendly_name ?? friendlyName ?? null,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
  }

  /**
   * Issues a challenge for an existing factor. The user must respond with the
   * current TOTP code via {@link verify} within the challenge expiry window.
   *
   * @param {string} accessToken - The user's current access token
   * @param {string} factorId - The factor to challenge
   * @returns {Promise<MfaChallengeResult>} Challenge ID + expiry
   */
  async challenge(
    accessToken: string,
    factorId: string,
  ): Promise<MfaChallengeResult> {
    const client = this.clientFor(accessToken);
    const { data, error } = await client.auth.mfa.challenge({ factorId });

    if (error || !data) {
      this.logger.warn(`MFA challenge failed: ${error?.message}`);
      throw new BadRequestException(error?.message || 'MFA challenge failed');
    }

    return {
      challengeId: data.id,
      expiresAt: data.expires_at,
    };
  }

  /**
   * Verifies a TOTP code against an outstanding challenge. On success, returns
   * a new token pair with `aal=aal2` — the controller writes these as cookies.
   *
   * @param {string} accessToken - The current access token (aal1)
   * @param {string} factorId - The factor being verified
   * @param {string} challengeId - The challenge from {@link challenge}
   * @param {string} code - The 6-digit TOTP code
   * @returns {Promise<MfaVerifyResult>} New aal2 token pair
   */
  async verify(
    accessToken: string,
    factorId: string,
    challengeId: string,
    code: string,
  ): Promise<MfaVerifyResult> {
    const client = this.clientFor(accessToken);
    const { data, error } = await client.auth.mfa.verify({
      factorId,
      challengeId,
      code,
    });

    if (error || !data) {
      this.logger.warn(`MFA verify failed: ${error?.message}`);
      if (this.isInvalidTotpError(error)) {
        throw new BadRequestException(error?.message || 'MFA verify failed');
      }
      throw new UnauthorizedException(error?.message || 'MFA verify failed');
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      token_type: 'bearer',
    };
  }

  /**
   * Unenrolls a factor. After this returns, the user falls back to aal1 on
   * their next refresh.
   *
   * @param {string} accessToken - The user's current access token
   * @param {string} factorId - The factor to remove
   */
  async unenroll(accessToken: string, factorId: string): Promise<void> {
    await this.assertRecentTotpForFactorManagement(accessToken, factorId);

    const client = this.clientFor(accessToken);
    const { error } = await client.auth.mfa.unenroll({ factorId });
    if (error) {
      this.logger.warn(`MFA unenroll failed: ${error.message}`);
      throw new BadRequestException(error.message);
    }
  }

  /**
   * Lists the factors enrolled for the user. Returns both verified and
   * unverified factors (the latter occur during enrollment if the user
   * abandoned the QR step).
   *
   * @param {string} accessToken - The user's current access token
   * @returns {Promise<MfaFactor[]>}
   */
  async listFactors(accessToken: string): Promise<MfaFactor[]> {
    const client = this.clientFor(accessToken);
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) {
      this.logger.warn(`MFA listFactors failed: ${error.message}`);
      throw new BadRequestException(error.message);
    }
    const all = [...(data?.totp ?? []), ...(data?.all ?? [])];
    // Dedupe on id (totp is a subset of all in some Supabase versions).
    const seen = new Set<string>();
    return all
      .filter((f) => {
        if (seen.has(f.id)) return false;
        seen.add(f.id);
        return true;
      })
      .map((f) => ({
        id: f.id,
        factorType: f.factor_type,
        friendlyName: f.friendly_name ?? null,
        status: f.status,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
      }));
  }

  /**
   * Returns the user's current and required MFA assurance levels. Used by the
   * Next.js middleware to decide whether to redirect to the TOTP page.
   *
   * @param {string} accessToken - The user's current access token
   */
  async getAal(
    accessToken: string,
    options: { forceMfa?: boolean } = {},
  ): Promise<{
    currentLevel: string | null;
    nextLevel: string | null;
    mfaRequired: boolean;
    authenticationMethod: string | null;
    stepUpReason: string | null;
    recentTotpRequired: boolean;
    currentAuthenticationMethods: { method: string; timestamp: number }[];
  }> {
    const client = this.clientFor(accessToken);
    const {
      data: { user },
      error,
    } = await client.auth.getUser();

    if (error || !user) {
      throw new UnauthorizedException(error?.message || 'AAL lookup failed');
    }

    const passkeyAssured =
      await this.resolvePasskeySessionAssurance(accessToken);
    const state = deriveSessionMfaState({
      accessToken,
      factors: (user.factors ?? []) as AuthUserFactor[],
      passkeyAssured,
      forceMfa: options.forceMfa,
      recentTotpSeconds: this.configService.get<number>(
        'passkeys.recentTotpSeconds',
      ),
    });

    return {
      currentLevel: state.currentLevel,
      nextLevel: state.nextLevel,
      mfaRequired: state.mfaRequired,
      authenticationMethod: state.authenticationMethod,
      stepUpReason: state.stepUpReason,
      recentTotpRequired: state.recentTotpRequired,
      currentAuthenticationMethods: state.currentAuthenticationMethods,
    };
  }

  private async assertRecentTotpForFactorManagement(
    accessToken: string,
    factorId?: string,
  ): Promise<void> {
    const client = this.clientFor(accessToken);
    const {
      data: { user },
      error,
    } = await client.auth.getUser();

    if (error || !user) {
      throw new UnauthorizedException(error?.message || 'AAL lookup failed');
    }

    const state = deriveSessionMfaState({
      accessToken,
      factors: (user.factors ?? []) as AuthUserFactor[],
      recentTotpSeconds: this.configService.get<number>(
        'passkeys.recentTotpSeconds',
      ),
    });

    if (state.hasVerifiedTotp && !state.hasRecentTotp) {
      throw new UnauthorizedException(
        'Recent TOTP verification required to manage authenticator app factors',
      );
    }

    if (!factorId) return;

    const verifiedTotpFactors = (user.factors ?? []).filter(
      (factor) =>
        factor.status === 'verified' &&
        factor.factor_type?.toLowerCase() === 'totp',
    );
    const isTargetVerifiedTotp = verifiedTotpFactors.some(
      (factor) => (factor as { id?: string }).id === factorId,
    );

    if (!isTargetVerifiedTotp || verifiedTotpFactors.length !== 1) {
      return;
    }

    const authUserId = user.id;
    const verifiedPasskeyCount =
      await this.passkeySessionAssurance?.countVerifiedPasskeys?.(authUserId);

    if ((verifiedPasskeyCount ?? 0) > 0) {
      throw new BadRequestException(
        'Cannot remove the last authenticator app while verified passkeys exist',
      );
    }
  }

  private async resolvePasskeySessionAssurance(
    accessToken: string,
  ): Promise<boolean> {
    const tokenPayload = getSessionAssuranceTokenPayload(accessToken);
    const authUserId =
      typeof tokenPayload?.sub === 'string' ? tokenPayload.sub : null;
    const sessionId =
      typeof tokenPayload?.session_id === 'string'
        ? tokenPayload.session_id
        : null;
    const methods = normalizeAuthenticationMethods(tokenPayload?.amr);

    if (
      !methods.some((method) => method.method.toLowerCase() === 'passkey') ||
      !authUserId ||
      !sessionId ||
      !this.passkeySessionAssurance
    ) {
      return false;
    }

    try {
      return await this.passkeySessionAssurance.isSessionAssured({
        accessToken,
        authUserId,
        sessionId,
      });
    } catch (error) {
      this.logger.warn(
        `Passkey session assurance lookup failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
  }

  private isInvalidTotpError(
    error: { message?: string; code?: string } | null | undefined,
  ): boolean {
    const message = error?.message?.toLowerCase() ?? '';
    const code = error?.code?.toLowerCase() ?? '';

    return (
      code === 'mfa_verification_failed' ||
      message.includes('invalid totp') ||
      message.includes('verification failed')
    );
  }
}
