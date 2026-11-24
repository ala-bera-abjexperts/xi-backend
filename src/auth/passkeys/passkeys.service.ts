import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MailService } from '../../mail/mail.service';
import { OnPremiseTenantService } from '../../on-premise/on-premise-tenant.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { UsersService } from '../../users/users.service';
import type { SigninResponse } from '../interfaces/auth-response.interface';
import {
  deriveSessionMfaState,
  getSessionAssuranceTokenPayload,
} from '../mfa/session-assurance.util';
import {
  ensureCredentialOrigin,
  ensureUserVerifiedAndPresent,
  readAssertionFlags,
  readRegistrationFlags,
  type PasskeyCredential,
} from './passkey-credential.util';
import {
  PASSKEY_SESSION_ASSURANCE,
  type PasskeySessionAssuranceReader,
} from './passkey-session-assurance.port';

type AuthSessionPayload = {
  sub?: string;
  session_id?: string;
  exp?: number;
  aal?: string;
  amr?: Array<{ method?: string; timestamp?: number } | string>;
};

type AuthUserProfile = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};

type PendingTrustedDevicePayload = {
  authUserId: string;
  publicUserId: string;
  sessionId: string;
  token: string;
  countryCode: string | null;
  issuedAt: number;
};

type AssuranceCookiePayload = {
  authUserId: string;
  sessionId: string;
  authenticationMethod: 'passkey';
  expiresAt: number;
};

type TrustedDeviceRow = {
  id: string;
  country_code: string | null;
};

type VerifyAuthenticationContext = {
  origin: string;
  trustedDeviceCookie?: string;
  pendingTrustedDeviceCookie?: string;
  countryCode?: string | null;
};

/**
 * Per-account slots inside one shared-domain cookie: `authUserId -> raw token`
 * (trusted device) or `authUserId -> pending payload` (step-up in flight).
 *
 * Both cookies used to hold a single value, so signing in to a second account
 * on the same browser overwrote the first account's slot; neither account was
 * ever recognized again and both were forced through TOTP on every sign-in.
 */
type TrustedDeviceTokenMap = Record<string, string>;
type PendingTrustedDeviceMap = Record<string, PendingTrustedDevicePayload>;

/**
 * Slot ceiling per cookie. Bounds the header size; the oldest slot is evicted,
 * costing that account one extra TOTP step-up.
 *
 * Lowered from 5 to 3 after 5 slots produced a RESPONSE header block large
 * enough for nginx to reject with `upstream sent too big header` — a 502 on
 * passkey sign-in even though the request had fully succeeded. Each slot is a
 * 36-char uuid plus a 43-char token, and this endpoint sets two of these maps
 * alongside the access/refresh JWTs. Three covers the real case (a person with
 * two accounts on one machine) with headroom; raising it again means measuring
 * the Set-Cookie total, not guessing.
 */
const TRUSTED_DEVICE_MAP_LIMIT = 3;

/** Fallback when `PASSKEY_MAX_PER_USER` is unset; mirrors the frontend cap. */
const DEFAULT_MAX_PASSKEYS_PER_USER = 10;

type SessionRisk = {
  level: 'low' | 'high';
  reasons: string[];
  trustedDeviceId: string | null;
  trustedDeviceValue: string | null;
  pendingTrustedDeviceValue: string | null;
};

type PasskeySigninResponse = Omit<
  SigninResponse,
  'access_token' | 'refresh_token' | 'expires_in' | 'token_type'
>;

type PasskeyOptionsResult = {
  challengeId: string;
  options: Record<string, unknown>;
  expiresAt: number;
};

@Injectable()
export class PasskeysService implements OnModuleInit {
  private readonly logger = new Logger(PasskeysService.name);
  private readonly trustedDeviceCookieName = 'auth_passkey_trusted_device';
  private readonly pendingTrustedDeviceCookieName =
    'auth_passkey_pending_device';
  private readonly assuranceCookieName = 'auth_assurance';
  private readonly pendingTrustedDeviceMaxAgeSeconds = 10 * 60;
  private readonly assuranceCookieMaxAgeSeconds = 15 * 60;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly onPremiseTenant: OnPremiseTenantService,
    private readonly mailService: MailService,
    @Optional()
    @Inject(PASSKEY_SESSION_ASSURANCE)
    private readonly sessionAssurance?: PasskeySessionAssuranceReader,
  ) {}

  /**
   * Fail LOUDLY at boot, never fatally. These three tables ship in a migration
   * that lives in a different repository and is applied by hand, and PostgREST
   * caches the schema at startup — so "table missing" and "table present but
   * uncached" have both reached production and surfaced only as a user-facing
   * passkey login failure. One log line at boot turns that into a deploy-time
   * signal.
   *
   * Deliberately does NOT throw: passkeys are one auth path of three, and
   * refusing to boot over them would take Azure and password login down too.
   */
  onModuleInit(): void {
    if (!this.configService.get<boolean>('passkeys.enabled')) return;

    // NOT awaited, on purpose. Nest awaits whatever onModuleInit returns, so an
    // awaited probe puts three network round trips on the bootstrap critical
    // path: if Supabase is slow or unreachable the app never starts listening
    // and the proxy 502s EVERY endpoint, including password and OAuth login.
    // A diagnostic that can take the whole service down is worse than the
    // problem it reports. Non-throwing was not enough; it must also be
    // non-blocking. Errors are logged inside, so nothing can reject here.
    void this.probePasskeyTables();
  }

  private async probePasskeyTables(): Promise<void> {
    const tables = [
      'auth_session_assurance',
      'auth_trusted_devices',
      'auth_security_events',
    ];

    await Promise.all(
      tables.map(async (table) => {
        try {
          // Bounded: a hung socket must not leave a dangling handle for the
          // lifetime of the process.
          const probe = this.supabaseAdmin
            .getClient()
            .from(table)
            .select('*', { head: true, count: 'exact' })
            .limit(1);

          const result = await Promise.race([
            probe,
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 5000).unref?.(),
            ),
          ]);

          if (result === null) {
            this.logger.warn(
              `passkey preflight: probing public.${table} timed out after 5s; skipping`,
            );

            return;
          }

          if (result.error) {
            this.logger.error(
              `passkey preflight: public.${table} unreachable — passkey LOGIN will fail ` +
                `(enrollment will appear to work). code=${result.error.code ?? '-'} ` +
                `message=${result.error.message}. ` +
                `If the table exists, run: notify pgrst, 'reload schema';`,
            );
          }
        } catch (err) {
          this.logger.error(
            `passkey preflight: probing public.${table} threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  }

  getTrustedDeviceCookieName(): string {
    return this.trustedDeviceCookieName;
  }

  getPendingTrustedDeviceCookieName(): string {
    return this.pendingTrustedDeviceCookieName;
  }

  getAssuranceCookieName(): string {
    return this.assuranceCookieName;
  }

  getTrustedDeviceMaxAgeSeconds(): number {
    return (
      (this.configService.get<number>('passkeys.trustedDeviceTtlDays') ?? 90) *
      24 *
      60 *
      60
    );
  }

  getPendingTrustedDeviceMaxAgeSeconds(): number {
    return this.pendingTrustedDeviceMaxAgeSeconds;
  }

  getAssuranceCookieMaxAgeSeconds(): number {
    return this.assuranceCookieMaxAgeSeconds;
  }

  async startRegistration(accessToken: string, origin: string) {
    this.assertPasskeysEnabled();
    this.assertExactOrigin(origin);
    const user = await this.assertVerifiedTotpEnrollment(accessToken);
    this.assertRecentTotp(accessToken);
    await this.assertPasskeyLimit(user.id);

    const data = await this.gotrueRequest<{
      challenge_id: string;
      options: unknown;
      expires_at: number;
    }>('POST', '/passkeys/registration/options', accessToken, {});

    return {
      challengeId: data.challenge_id,
      options: data.options,
      expiresAt: data.expires_at,
    };
  }

  async verifyRegistration(
    input: {
      challengeId: string;
      friendlyName: string;
      credential: PasskeyCredential;
    },
    accessToken: string,
    origin: string,
  ) {
    this.assertPasskeysEnabled();
    this.assertExactOrigin(origin);
    const friendlyName = this.normalizeFriendlyName(input.friendlyName);
    await this.assertVerifiedTotpEnrollment(accessToken);
    this.assertRecentTotp(accessToken);
    ensureCredentialOrigin(
      input.credential,
      origin,
      [this.getRequiredOrigin()],
      'webauthn.create',
    );
    ensureUserVerifiedAndPresent(readRegistrationFlags(input.credential));

    const data = await this.gotrueRequest<{
      id: string;
      friendly_name?: string;
      created_at: string;
    }>('POST', '/passkeys/registration/verify', accessToken, {
      challenge_id: input.challengeId,
      credential: input.credential,
    });

    let result = data;
    let partialSuccess = false;
    let warning: string | null = null;
    if (friendlyName) {
      try {
        result = await this.gotrueRequest<{
          id: string;
          friendly_name?: string;
          created_at: string;
        }>('PATCH', `/passkeys/${data.id}`, accessToken, {
          friendly_name: friendlyName,
        });
      } catch (err) {
        partialSuccess = true;
        warning =
          err instanceof BadRequestException
            ? this.extractExceptionMessage(err)
            : 'Passkey registered, but the label update failed';
      }
    }

    const tokenPayload =
      await this.getRequiredVerifiedTokenPayload(accessToken);
    await this.writeSecurityEvent({
      authUserId: tokenPayload.sub ?? null,
      sessionId: tokenPayload.session_id ?? null,
      eventType: 'passkey_enrolled',
      authenticationMethod: 'passkey',
      deviceLabel: result.friendly_name ?? null,
      metadata: { passkeyId: result.id },
    });

    return {
      id: result.id,
      friendlyName: result.friendly_name ?? null,
      createdAt: result.created_at,
      partialSuccess,
      warning,
    };
  }

  async trustCurrentDeviceAfterEnrollment(input: {
    accessToken: string;
    currentTrustedDeviceCookie?: string;
    countryCode?: string | null;
  }): Promise<string | null> {
    try {
      const tokenPayload = await this.getRequiredVerifiedTokenPayload(
        input.accessToken,
      );
      if (tokenPayload.aal !== 'aal2') {
        throw new UnauthorizedException('MFA step-up is not complete');
      }
      this.assertRecentTotp(input.accessToken);

      const deviceMap = this.readTrustedDeviceMap(
        input.currentTrustedDeviceCookie,
      );
      const currentToken = deviceMap[tokenPayload.sub!];
      const currentDevice = currentToken
        ? await this.lookupTrustedDevice(tokenPayload.sub!, currentToken)
        : null;
      const trustedDeviceToken = currentDevice
        ? currentToken
        : this.generateTrustedDeviceToken();
      const now = new Date().toISOString();
      const expiresAt = this.trustedDeviceExpiryDate().toISOString();
      const countryCode = this.normalizeCountryCode(input.countryCode);
      const client = this.supabaseAdmin.getClient();
      const result = currentDevice
        ? await client
            .from('auth_trusted_devices')
            .update({
              country_code: countryCode,
              trusted_at: now,
              last_seen_at: now,
              expires_at: expiresAt,
              revoked_at: null,
              updated_at: now,
            })
            .eq('id', currentDevice.id)
            .eq('auth_user_id', tokenPayload.sub!)
        : await client.from('auth_trusted_devices').insert({
            auth_user_id: tokenPayload.sub!,
            token_hmac: this.hashTrustedDeviceToken(trustedDeviceToken),
            country_code: countryCode,
            trusted_at: now,
            last_seen_at: now,
            expires_at: expiresAt,
          });

      if (result.error) {
        throw new Error(result.error.message);
      }

      return this.signTrustedDeviceCookie(
        this.mergeCookieSlot(deviceMap, tokenPayload.sub!, trustedDeviceToken),
      );
    } catch (error) {
      // Registration has already succeeded. Preserve the credential and fail
      // closed: without this cookie the next passkey sign-in requires TOTP.
      this.logger.warn(
        `post-enrollment device trust failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }

  async startAuthentication(origin: string): Promise<PasskeyOptionsResult> {
    this.assertPasskeysEnabled();
    this.assertExactOrigin(origin);

    const client = this.publicPasskeyClient();
    const { data, error } = await client.auth.passkey.startAuthentication();

    if (error || !data) {
      throw new BadRequestException(error?.message || 'Passkey sign-in failed');
    }

    return {
      challengeId: data.challenge_id,
      options: data.options as unknown as Record<string, unknown>,
      expiresAt: data.expires_at,
    };
  }

  async verifyAuthentication(
    input: {
      challengeId: string;
      credential: PasskeyCredential;
    },
    context: VerifyAuthenticationContext,
  ) {
    this.assertPasskeysEnabled();
    this.assertExactOrigin(context.origin);
    ensureCredentialOrigin(
      input.credential,
      context.origin,
      [this.getRequiredOrigin()],
      'webauthn.get',
    );
    ensureUserVerifiedAndPresent(readAssertionFlags(input.credential));

    const client = this.publicPasskeyClient();
    const { data, error } = await client.auth.passkey.verifyAuthentication({
      challengeId: input.challengeId,
      // The DTO allowlists the complete SimpleWebAuthn JSON shape. auth-js
      // keeps its WebAuthn DOM union private, so casting avoids leaking a
      // non-portable pnpm store path into generated declarations.
      credential: input.credential as never,
    });

    if (error || !data?.session || !data.user) {
      throw new UnauthorizedException(
        error?.message || 'Passkey sign-in failed',
      );
    }

    const accessToken = data.session.access_token;
    const tokenPayload =
      await this.getRequiredVerifiedTokenPayload(accessToken);
    this.assertPasskeyAmr(tokenPayload);

    if (tokenPayload.sub !== data.user.id) {
      await this.bestEffortSignOut(client);
      throw new UnauthorizedException('Invalid session');
    }

    const verifiedUser = await this.requireAuthenticatedUser(accessToken);
    if (verifiedUser.id !== data.user.id) {
      await this.bestEffortSignOut(client);
      throw new UnauthorizedException('Invalid session');
    }

    const publicUser = (await this.usersService.getUserByAuthUserId(
      data.user.id,
    )) as AuthUserProfile | null;
    if (!publicUser) {
      throw new UnauthorizedException('User profile missing');
    }

    const hasVerifiedTotp =
      verifiedUser.factors?.some(
        (factor) =>
          factor.factor_type === 'totp' && factor.status === 'verified',
      ) ?? false;

    const risk = await this.evaluateRisk({
      authUserId: data.user.id,
      publicUserId: publicUser.id,
      sessionId: tokenPayload.session_id!,
      countryCode: this.normalizeCountryCode(context.countryCode),
      trustedDeviceCookie: context.trustedDeviceCookie,
      pendingTrustedDeviceCookie: context.pendingTrustedDeviceCookie,
    });

    const assurancePersisted = await this.persistSessionAssurance(client, {
      sessionId: tokenPayload.session_id!,
      authUserId: data.user.id,
      expiresAt: tokenPayload.exp!,
      risk,
      countryCode: this.normalizeCountryCode(context.countryCode),
    });

    // A failed assurance write cannot grant the TOTP-skip, so treat it exactly
    // like high risk: require step-up rather than reject a verified assertion.
    const requiresStepUp = risk.level === 'high' || !assurancePersisted;

    if (requiresStepUp && !hasVerifiedTotp) {
      await this.writeSecurityEvent({
        authUserId: data.user.id,
        sessionId: tokenPayload.session_id!,
        eventType: 'passkey_login_rejected',
        authenticationMethod: 'passkey',
        riskLevel: 'high',
        reasonCodes: [...risk.reasons, 'totp_not_configured'],
        countryCode: this.normalizeCountryCode(context.countryCode),
      });
      await this.bestEffortSignOut(client);
      throw new ForbiddenException({
        message: 'High-risk passkey login requires an enrolled MFA app code',
        code: 'passkey_high_risk_totp_required',
      });
    }

    const signin = await this.buildSigninResponse({
      accessToken: data.session.access_token,
      factors: verifiedUser.factors,
      publicUser,
      mfaRequired: requiresStepUp,
      passkeyAssured: !requiresStepUp,
    });

    const eventType = requiresStepUp
      ? 'passkey_login_step_up_required'
      : 'passkey_login_succeeded';

    await this.writeSecurityEvent({
      authUserId: data.user.id,
      sessionId: tokenPayload.session_id!,
      eventType,
      authenticationMethod: 'passkey',
      riskLevel: risk.level,
      reasonCodes: risk.reasons,
      countryCode: this.normalizeCountryCode(context.countryCode),
    });

    if (risk.level === 'high') {
      await this.sendHighRiskNotificationOnce({
        authUserId: data.user.id,
        sessionId: tokenPayload.session_id!,
        email: publicUser.email,
        firstName: publicUser.first_name,
        countryCode: this.normalizeCountryCode(context.countryCode),
        reasons: risk.reasons,
      });
    }

    return {
      authUserId: data.user.id,
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
      },
      response: signin,
      cookies: {
        trustedDeviceValue: risk.trustedDeviceValue,
        pendingTrustedDeviceValue: risk.pendingTrustedDeviceValue,
        assuranceValue:
          risk.level === 'low' ? this.signAssuranceCookie(tokenPayload) : null,
      },
    };
  }

  async finalizeTrustedDevice(
    accessToken: string,
    pendingTrustedDeviceCookie: string | undefined,
    trustedDeviceCookie?: string,
  ) {
    if (!pendingTrustedDeviceCookie) {
      throw new BadRequestException('Pending trusted device missing');
    }

    const tokenPayload =
      await this.getRequiredVerifiedTokenPayload(accessToken);
    if (tokenPayload.aal !== 'aal2') {
      throw new UnauthorizedException('MFA step-up is not complete');
    }

    const pending = this.verifyPendingTrustedDeviceCookie(
      pendingTrustedDeviceCookie,
      tokenPayload.sub!,
    );
    if (
      pending.authUserId !== tokenPayload.sub ||
      pending.sessionId !== tokenPayload.session_id
    ) {
      throw new UnauthorizedException(
        'Trusted device does not belong to this user',
      );
    }

    const deviceMap = this.readTrustedDeviceMap(trustedDeviceCookie);
    const supersededToken = deviceMap[pending.authUserId];
    const tokenHmac = this.hashTrustedDeviceToken(pending.token);
    const expiresAt = this.trustedDeviceExpiryDate().toISOString();
    const client = this.supabaseAdmin.getClient();
    const existing = await client
      .from('auth_trusted_devices')
      .select('id')
      .eq('auth_user_id', pending.authUserId)
      .eq('token_hmac', tokenHmac)
      .maybeSingle();

    let trustedDeviceId = (existing.data as { id?: string } | null)?.id ?? null;
    if (!trustedDeviceId) {
      const inserted = await client
        .from('auth_trusted_devices')
        .insert({
          auth_user_id: pending.authUserId,
          token_hmac: tokenHmac,
          country_code: pending.countryCode,
          trusted_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          expires_at: expiresAt,
        })
        .select('id')
        .single();

      if (inserted.error || !inserted.data) {
        throw new BadRequestException('Failed to trust this device');
      }

      trustedDeviceId = (inserted.data as { id: string }).id;
    } else {
      const updated = await client
        .from('auth_trusted_devices')
        .update({
          country_code: pending.countryCode,
          trusted_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          expires_at: expiresAt,
          revoked_at: null,
        })
        .eq('id', trustedDeviceId);

      if (updated.error) {
        throw new BadRequestException('Failed to trust this device');
      }
    }

    if (supersededToken && supersededToken !== pending.token) {
      // The row this browser slot just replaced is unreachable from here on —
      // its raw token is gone from the cookie — so retire it instead of letting
      // it sit until the 90-day expiry. Scoped to this slot's token: the user's
      // other browsers keep their own trusted-device rows.
      const revoked = await client
        .from('auth_trusted_devices')
        .update({
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('auth_user_id', pending.authUserId)
        .eq('token_hmac', this.hashTrustedDeviceToken(supersededToken))
        .is('revoked_at', null);

      if (revoked.error) {
        this.logger.warn(
          `superseded trusted device revoke failed: ${revoked.error.message}`,
        );
      }
    }

    const assuranceUpdate = await client
      .from('auth_session_assurance')
      .update({
        trusted_device_id: trustedDeviceId,
        risk_level: 'low',
        risk_reasons: [],
        step_up_required: false,
        step_up_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('session_id', pending.sessionId)
      .eq('auth_user_id', pending.authUserId)
      .select('session_id')
      .maybeSingle();

    if (assuranceUpdate.error || !assuranceUpdate.data) {
      throw new BadRequestException('Failed to complete passkey step-up');
    }

    await this.writeSecurityEvent({
      authUserId: pending.authUserId,
      sessionId: pending.sessionId,
      eventType: 'totp_step_up_completed',
      authenticationMethod: 'passkey',
      riskLevel: 'low',
      countryCode: pending.countryCode,
    });

    return {
      trustedDeviceValue: this.signTrustedDeviceCookie(
        this.mergeCookieSlot(deviceMap, pending.authUserId, pending.token),
      ),
      // Only this account's slot is consumed; a concurrent sign-in's pending
      // step-up stays in the cookie instead of being cleared out from under it.
      pendingTrustedDeviceValue: this.serializeSlots(
        this.withoutCookieSlot(
          this.readPendingTrustedDeviceMap(pendingTrustedDeviceCookie),
          pending.authUserId,
        ),
      ),
      assuranceValue: this.signAssuranceCookie(tokenPayload),
    };
  }

  /**
   * Drops one account's slot from the pending-device cookie without touching
   * the others. Used on the /auth/mfa/verify swallow path so a poisoned slot
   * cannot be retried forever, while a concurrent sign-in keeps its own.
   *
   * @param {string} pendingTrustedDeviceCookie - Raw cookie value
   * @param {string} accessToken - The aal2 token just issued by GoTrue
   * @returns {string | null} The remaining cookie value, or null when empty
   */
  dropPendingTrustedDevice(
    pendingTrustedDeviceCookie: string,
    accessToken: string,
  ): string | null {
    const sub = getSessionAssuranceTokenPayload(accessToken)?.sub;
    const pendingMap = this.readPendingTrustedDeviceMap(
      pendingTrustedDeviceCookie,
    );

    return typeof sub === 'string'
      ? this.serializeSlots(this.withoutCookieSlot(pendingMap, sub))
      : null;
  }

  async listPasskeys(accessToken: string) {
    this.assertPasskeysEnabled();

    const data = await this.gotrueRequest<
      Array<{
        id: string;
        friendly_name?: string;
        created_at: string;
        last_used_at?: string;
      }>
    >('GET', '/passkeys', accessToken);

    return data.map((item) => ({
      id: item.id,
      friendlyName: item.friendly_name ?? null,
      createdAt: item.created_at,
      lastUsedAt: item.last_used_at ?? null,
    }));
  }

  async renamePasskey(
    accessToken: string,
    passkeyId: string,
    friendlyName: string,
  ) {
    this.assertPasskeysEnabled();
    const normalizedFriendlyName = this.normalizeFriendlyName(friendlyName);
    await this.assertVerifiedTotpEnrollment(accessToken);
    this.assertRecentTotp(accessToken);

    const data = await this.gotrueRequest<{
      id: string;
      friendly_name?: string;
      created_at: string;
      last_used_at?: string;
    }>('PATCH', `/passkeys/${passkeyId}`, accessToken, {
      friendly_name: normalizedFriendlyName,
    });

    const tokenPayload = this.getRequiredTokenPayload(accessToken);
    await this.writeSecurityEvent({
      authUserId: tokenPayload.sub ?? null,
      sessionId: tokenPayload.session_id ?? null,
      eventType: 'passkey_renamed',
      authenticationMethod: 'passkey',
      deviceLabel: data.friendly_name ?? null,
      metadata: { passkeyId: data.id },
    });

    return {
      id: data.id,
      friendlyName: data.friendly_name ?? null,
      createdAt: data.created_at,
      lastUsedAt: data.last_used_at ?? null,
    };
  }

  async deletePasskey(accessToken: string, passkeyId: string) {
    this.assertPasskeysEnabled();
    await this.assertVerifiedTotpEnrollment(accessToken);
    this.assertRecentTotp(accessToken);

    const listed = await this.listPasskeys(accessToken);
    const existing = listed.find((item) => item.id === passkeyId);
    await this.gotrueRequest(
      'DELETE',
      `/passkeys/${passkeyId}`,
      accessToken,
      undefined,
      false,
    );

    const tokenPayload = this.getRequiredTokenPayload(accessToken);
    await this.writeSecurityEvent({
      authUserId: tokenPayload.sub ?? null,
      sessionId: tokenPayload.session_id ?? null,
      eventType: 'passkey_deleted',
      authenticationMethod: 'passkey',
      deviceLabel: existing?.friendlyName ?? null,
      metadata: { passkeyId },
    });
  }

  /**
   * Signs the per-account trusted-device slot map.
   *
   * @param {TrustedDeviceTokenMap} map - `authUserId -> raw trusted-device token`
   * @returns {string} `${base64url(json)}.${hmac}`
   */
  signTrustedDeviceCookie(map: TrustedDeviceTokenMap): string {
    return this.signCookieSlots(map);
  }

  /**
   * Merges one account's pending step-up state into the existing cookie rather
   * than replacing it, so two concurrent sign-ins do not clobber each other.
   *
   * @param {PendingTrustedDevicePayload} payload - The slot to write
   * @param {string} [currentCookie] - Existing pending-device cookie value
   * @returns {string} The signed, merged cookie value
   */
  signPendingTrustedDeviceCookie(
    payload: PendingTrustedDevicePayload,
    currentCookie?: string,
  ): string {
    return this.signCookieSlots(
      this.mergeCookieSlot(
        this.readPendingTrustedDeviceMap(currentCookie),
        payload.authUserId,
        payload,
      ),
    );
  }

  /** Signs any slot map with the shared trusted-device secret. @private */
  private signCookieSlots(slots: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(slots), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.getTrustedDeviceSecret())
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  /** Signs a slot map, or returns null when it is empty (clear the cookie). @private */
  private serializeSlots(slots: Record<string, unknown>): string | null {
    return Object.keys(slots).length > 0 ? this.signCookieSlots(slots) : null;
  }

  /**
   * Verifies the envelope and returns the decoded slot map. Returns `null` for
   * any absent, unsigned, tampered, or non-object value — including a legacy
   * single-value cookie, which simply has no slots.
   *
   * @private
   */
  private readCookieSlots(
    value: string | undefined,
  ): Record<string, unknown> | null {
    if (!value) return null;

    const [body, signature] = value.split('.');
    if (!body || !signature) return null;

    const expected = createHmac('sha256', this.getTrustedDeviceSecret())
      .update(body)
      .digest('base64url');
    if (
      expected.length !== signature.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as unknown;

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads the trusted-device cookie. A pre-map cookie (one raw token, no
   * envelope) decodes to an empty map rather than throwing: that account takes
   * one extra TOTP step-up once, then lands in a slot.
   *
   * @private
   */
  private readTrustedDeviceMap(
    value: string | undefined,
  ): TrustedDeviceTokenMap {
    const slots = this.readCookieSlots(value);
    if (!slots) return {};

    return Object.fromEntries(
      Object.entries(slots).filter(
        ([, token]) => typeof token === 'string' && token.length > 0,
      ),
    ) as TrustedDeviceTokenMap;
  }

  /** @private */
  private readPendingTrustedDeviceMap(
    value: string | undefined,
  ): PendingTrustedDeviceMap {
    const slots = this.readCookieSlots(value);
    if (!slots) return {};

    // Pre-map cookie: a single payload at the top level. Keep the in-flight
    // step-up working across the deploy instead of failing it.
    if (typeof (slots as PendingTrustedDevicePayload).token === 'string') {
      const legacy = slots as unknown as PendingTrustedDevicePayload;
      return typeof legacy.authUserId === 'string'
        ? { [legacy.authUserId]: legacy }
        : {};
    }

    return Object.fromEntries(
      Object.entries(slots).filter(
        ([, payload]) => payload !== null && typeof payload === 'object',
      ),
    ) as PendingTrustedDeviceMap;
  }

  /**
   * Writes `key` as the newest slot, capped at {@link TRUSTED_DEVICE_MAP_LIMIT}
   * by evicting the oldest. Insertion order is the recency order — every key is
   * a UUID, so JS preserves it through JSON round-trips.
   *
   * @private
   */
  private mergeCookieSlot<T>(
    slots: Record<string, T>,
    key: string,
    value: T,
  ): Record<string, T> {
    const others = Object.entries(this.withoutCookieSlot(slots, key)).slice(
      -(TRUSTED_DEVICE_MAP_LIMIT - 1),
    );

    return Object.fromEntries([...others, [key, value]]) as Record<string, T>;
  }

  /** @private */
  private withoutCookieSlot<T>(
    slots: Record<string, T>,
    key: string,
  ): Record<string, T> {
    return Object.fromEntries(
      Object.entries(slots).filter(([slotKey]) => slotKey !== key),
    ) as Record<string, T>;
  }

  private signAssuranceCookie(payload: AuthSessionPayload): string {
    if (!payload.sub || !payload.session_id || !payload.exp) {
      throw new UnauthorizedException('Invalid session');
    }

    const cookiePayload: AssuranceCookiePayload = {
      authUserId: payload.sub,
      sessionId: payload.session_id,
      authenticationMethod: 'passkey',
      expiresAt: Math.min(
        payload.exp,
        Math.floor(Date.now() / 1000) + this.assuranceCookieMaxAgeSeconds,
      ),
    };
    const body = Buffer.from(JSON.stringify(cookiePayload), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.getTrustedDeviceSecret())
      .update(body)
      .digest('base64url');

    return `${body}.${signature}`;
  }

  private publicPasskeyClient(): SupabaseClient {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');
    if (!url || !anonKey) {
      throw new Error('Supabase URL/anonKey not configured');
    }

    return createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        experimental: { passkey: true },
      },
    }) as SupabaseClient;
  }

  private async gotrueRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    accessToken?: string,
    body?: unknown,
    expectJson = true,
  ): Promise<T> {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');
    if (!url || !anonKey) {
      throw new Error('Supabase URL/anonKey not configured');
    }

    const response = await fetch(`${url}/auth/v1${path}`, {
      method,
      headers: {
        apikey: anonKey,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      let message = 'Passkey request failed';
      let code = 'passkey_request_failed';
      try {
        const err = (await response.json()) as {
          msg?: string;
          message?: string;
          code?: string;
          error_code?: string;
        };
        message = err.message || err.msg || message;
        code = err.error_code || err.code || code;
      } catch {
        // Ignore JSON parse failure and keep generic message.
      }
      throw new BadRequestException({ message, code });
    }

    if (!expectJson) {
      return null as T;
    }

    return (await response.json()) as T;
  }

  private assertPasskeysEnabled(): void {
    if (!this.configService.get<boolean>('passkeys.enabled')) {
      throw new ForbiddenException('Passkeys are disabled');
    }
  }

  private assertExactOrigin(origin: string): void {
    if (origin !== this.getRequiredOrigin()) {
      throw new BadRequestException('Passkey origin mismatch');
    }
  }

  private getRequiredOrigin(): string {
    return this.configService.get<string>('passkeys.origin') || '';
  }

  private getTokenPayload(accessToken: string): AuthSessionPayload | null {
    const [, payload] = accessToken.split('.');
    if (!payload) return null;

    try {
      return JSON.parse(
        Buffer.from(this.toPaddedBase64(payload), 'base64').toString('utf8'),
      ) as AuthSessionPayload;
    } catch {
      return null;
    }
  }

  private getRequiredTokenPayload(accessToken: string): AuthSessionPayload {
    const payload = this.getTokenPayload(accessToken);
    if (!payload?.sub || !payload.session_id || !payload.exp) {
      throw new UnauthorizedException('Invalid session');
    }
    return payload;
  }

  private async getRequiredVerifiedTokenPayload(
    accessToken: string,
  ): Promise<AuthSessionPayload> {
    const { data, error } =
      await this.publicPasskeyClient().auth.getClaims(accessToken);

    if (error || !data?.claims) {
      throw new UnauthorizedException(error?.message || 'Invalid session');
    }

    const payload = data.claims as unknown as AuthSessionPayload;
    if (!payload.sub || !payload.session_id || !payload.exp) {
      throw new UnauthorizedException('Invalid session');
    }

    return payload;
  }

  private assertPasskeyAmr(payload: AuthSessionPayload): void {
    const methods = Array.isArray(payload.amr) ? payload.amr : [];
    const hasPasskey = methods.some((entry) =>
      typeof entry === 'string'
        ? entry === 'passkey'
        : entry?.method === 'passkey',
    );

    if (!hasPasskey) {
      throw new UnauthorizedException('Session is not passkey-authenticated');
    }
  }

  private assertRecentTotp(accessToken: string): void {
    const payload = this.getRequiredTokenPayload(accessToken);
    const maxAge =
      this.configService.get<number>('passkeys.recentTotpSeconds') ?? 600;
    const now = Math.floor(Date.now() / 1000);
    const methods = Array.isArray(payload.amr) ? payload.amr : [];
    const hasRecentTotp = methods.some((entry) => {
      if (typeof entry === 'string') return false;
      return (
        entry?.method === 'totp' &&
        typeof entry.timestamp === 'number' &&
        now - entry.timestamp <= maxAge
      );
    });

    if (!hasRecentTotp) {
      throw new ForbiddenException({
        message: 'Recent MFA app verification required',
        code: 'recent_totp_required',
      });
    }
  }

  private async assertVerifiedTotpEnrollment(accessToken: string) {
    const user = await this.requireAuthenticatedUser(accessToken);
    const hasVerifiedTotp =
      user.factors?.some(
        (factor) =>
          factor.factor_type === 'totp' && factor.status === 'verified',
      ) ?? false;

    if (!hasVerifiedTotp) {
      throw new ForbiddenException({
        message:
          'Enroll a verified MFA authenticator app before managing passkeys',
        code: 'totp_enrollment_required',
      });
    }

    return user;
  }

  /**
   * Server-side ceiling on credentials per account. The frontend enforced this
   * alone, so any direct API caller could register without limit.
   *
   * @private
   */
  private async assertPasskeyLimit(authUserId: string): Promise<void> {
    if (!this.sessionAssurance?.countVerifiedPasskeys) return;

    const limit =
      this.configService.get<number>('passkeys.maxPerUser') ??
      DEFAULT_MAX_PASSKEYS_PER_USER;
    const count = await this.sessionAssurance.countVerifiedPasskeys(authUserId);

    if (count >= limit) {
      throw new ForbiddenException({
        message: `You can register up to ${limit} passkeys. Remove one before adding another.`,
        code: 'too_many_passkeys',
      });
    }
  }

  private toPaddedBase64(value: string): string {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  }

  private async requireAuthenticatedUser(accessToken: string) {
    const client = this.publicPasskeyClient();
    const { data, error } = await client.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException(error?.message || 'Invalid session');
    }
    return data.user;
  }

  private async buildSigninResponse(input: {
    accessToken: string;
    factors:
      | Array<{ factor_type?: string; status?: string }>
      | null
      | undefined;
    publicUser: AuthUserProfile;
    mfaRequired: boolean;
    passkeyAssured: boolean;
  }): Promise<PasskeySigninResponse> {
    const defaultOrg = await this.computeDefaultOrganization(input.publicUser);
    const mfaState = deriveSessionMfaState({
      accessToken: input.accessToken,
      factors: input.factors,
      forceMfa: input.mfaRequired,
      passkeyAssured: input.passkeyAssured,
      recentTotpSeconds:
        this.configService.get<number>('passkeys.recentTotpSeconds') ?? 600,
    });

    return {
      user: {
        id: input.publicUser.id,
        email: input.publicUser.email,
        first_name: input.publicUser.first_name,
        last_name: input.publicUser.last_name,
      },
      mfaRequired: mfaState.mfaRequired,
      currentLevel: mfaState.currentLevel,
      nextLevel: mfaState.nextLevel,
      authenticationMethod: mfaState.authenticationMethod,
      stepUpReason: mfaState.stepUpReason,
      recentTotpRequired: mfaState.recentTotpRequired,
      defaultOrganization: defaultOrg.defaultOrganization,
      allOrganizationsDeactivated: defaultOrg.allOrganizationsDeactivated,
    };
  }

  private async computeDefaultOrganization(
    publicUser: AuthUserProfile,
  ): Promise<{
    defaultOrganization: SigninResponse['defaultOrganization'];
    allOrganizationsDeactivated: boolean;
  }> {
    await this.onPremiseTenant.ensureDefaultMembership(
      publicUser.id,
      publicUser.email,
    );

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('organization_members')
      .select('role, organizations!inner(id, slug, name, is_active)')
      .eq('user_id', publicUser.id)
      // organization_id breaks ties: memberships created in the same
      // transaction share a created_at, and the first active row wins below.
      .order('created_at', { ascending: true })
      .order('organization_id', { ascending: true });

    if (error || !data) {
      return {
        defaultOrganization: undefined,
        allOrganizationsDeactivated: false,
      };
    }

    const memberships = data
      .map((row) => {
        const org = row.organizations as {
          id?: string;
          slug?: string;
          name?: string;
          is_active?: boolean | null;
        } | null;
        if (!org?.id || !org.slug || !org.name) return null;
        return {
          id: org.id,
          slug: org.slug,
          name: org.name,
          role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
          isActive: org.is_active !== false,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const activeMembership = memberships.find(
      (membership) => membership.isActive,
    );

    if (activeMembership) {
      return {
        defaultOrganization: {
          id: activeMembership.id,
          slug: activeMembership.slug,
          name: activeMembership.name,
          role: activeMembership.role,
        },
        allOrganizationsDeactivated: false,
      };
    }

    return {
      defaultOrganization: null,
      allOrganizationsDeactivated: memberships.length > 0,
    };
  }

  private async evaluateRisk(input: {
    authUserId: string;
    publicUserId: string;
    sessionId: string;
    countryCode: string | null;
    trustedDeviceCookie?: string;
    pendingTrustedDeviceCookie?: string;
  }): Promise<SessionRisk> {
    const deviceMap = this.readTrustedDeviceMap(input.trustedDeviceCookie);
    const trustedDeviceToken = deviceMap[input.authUserId];
    const pendingFrom = (token: string) =>
      this.signPendingTrustedDeviceCookie(
        {
          authUserId: input.authUserId,
          publicUserId: input.publicUserId,
          sessionId: input.sessionId,
          token,
          countryCode: input.countryCode,
          issuedAt: Date.now(),
        },
        input.pendingTrustedDeviceCookie,
      );
    // Never hand back null while another account still holds a slot: the
    // controller clears the cookie on null, which would evict that account and
    // restart the step-up ping-pong this map exists to end.
    const keepOtherSlots = () => this.serializeSlots(deviceMap);

    if (!trustedDeviceToken) {
      const newToken = this.generateTrustedDeviceToken();
      return {
        level: 'high',
        reasons: ['unrecognized_device'],
        trustedDeviceId: null,
        trustedDeviceValue: keepOtherSlots(),
        pendingTrustedDeviceValue: pendingFrom(newToken),
      };
    }

    const trustedDevice = await this.lookupTrustedDevice(
      input.authUserId,
      trustedDeviceToken,
    );

    if (!trustedDevice) {
      const newToken = this.generateTrustedDeviceToken();
      return {
        level: 'high',
        reasons: ['unrecognized_device'],
        trustedDeviceId: null,
        trustedDeviceValue: keepOtherSlots(),
        pendingTrustedDeviceValue: pendingFrom(newToken),
      };
    }

    if (
      input.countryCode &&
      trustedDevice.country_code &&
      input.countryCode !== trustedDevice.country_code
    ) {
      return {
        level: 'high',
        reasons: ['unrecognized_location'],
        trustedDeviceId: trustedDevice.id,
        trustedDeviceValue: keepOtherSlots(),
        pendingTrustedDeviceValue: pendingFrom(trustedDeviceToken),
      };
    }

    const trustedDeviceUpdate = await this.supabaseAdmin
      .getClient()
      .from('auth_trusted_devices')
      .update({
        last_seen_at: new Date().toISOString(),
        ...(input.countryCode ? { country_code: input.countryCode } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', trustedDevice.id);

    if (trustedDeviceUpdate.error) {
      this.logger.warn(
        `trusted device update failed: ${trustedDeviceUpdate.error.message}`,
      );
      return {
        level: 'high',
        reasons: ['risk_store_failure'],
        trustedDeviceId: trustedDevice.id,
        trustedDeviceValue: keepOtherSlots(),
        pendingTrustedDeviceValue: pendingFrom(trustedDeviceToken),
      };
    }

    return {
      level: 'low',
      reasons: [],
      trustedDeviceId: trustedDevice.id,
      trustedDeviceValue: this.signTrustedDeviceCookie(deviceMap),
      pendingTrustedDeviceValue: this.serializeSlots(
        this.withoutCookieSlot(
          this.readPendingTrustedDeviceMap(input.pendingTrustedDeviceCookie),
          input.authUserId,
        ),
      ),
    };
  }

  private async lookupTrustedDevice(
    authUserId: string,
    rawToken: string,
  ): Promise<TrustedDeviceRow | null> {
    const tokenHmac = this.hashTrustedDeviceToken(rawToken);
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('auth_trusted_devices')
      .select('id, country_code')
      .eq('auth_user_id', authUserId)
      .eq('token_hmac', tokenHmac)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error) {
      this.logger.warn(`trusted device lookup failed: ${error.message}`);
      return null;
    }

    return (data as TrustedDeviceRow | null) ?? null;
  }

  private hashTrustedDeviceToken(rawToken: string): string {
    return createHmac('sha256', this.getTrustedDeviceSecret())
      .update(rawToken)
      .digest('base64url');
  }

  private generateTrustedDeviceToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private getTrustedDeviceSecret(): string {
    const secret = this.configService.get<string>(
      'passkeys.trustedDeviceSecret',
    );
    if (!secret) {
      throw new Error('PASSKEY_TRUSTED_DEVICE_SECRET is not configured');
    }
    return secret;
  }

  private trustedDeviceExpiryDate(): Date {
    return new Date(Date.now() + this.getTrustedDeviceMaxAgeSeconds() * 1000);
  }

  private verifyPendingTrustedDeviceCookie(
    value: string,
    authUserId: string,
  ): PendingTrustedDevicePayload {
    if (!this.readCookieSlots(value)) {
      throw new UnauthorizedException('Invalid trusted device state');
    }

    const payload = this.readPendingTrustedDeviceMap(value)[authUserId];
    if (!payload) {
      throw new UnauthorizedException(
        'Trusted device does not belong to this user',
      );
    }

    const age = Date.now() - payload.issuedAt;
    if (
      typeof payload.authUserId !== 'string' ||
      typeof payload.publicUserId !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.token !== 'string' ||
      payload.token.length < 32 ||
      !Number.isFinite(payload.issuedAt) ||
      age < -60_000 ||
      age > this.pendingTrustedDeviceMaxAgeSeconds * 1000
    ) {
      throw new UnauthorizedException('Trusted device state expired');
    }

    return payload;
  }

  private normalizeCountryCode(value?: string | null): string | null {
    if (!value) return null;
    const normalized = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
  }

  private normalizeFriendlyName(value: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 120) {
      throw new BadRequestException('Passkey name must be 1 to 120 characters');
    }
    return normalized;
  }

  /**
   * @returns true when the assurance row was written, false when it was not.
   *
   * Deliberately does NOT throw. By the time this runs the assertion is already
   * cryptographically verified (origin bound, UV flag checked, AMR verified), so
   * a database fault is OUR problem, not evidence the credential is bad.
   * Throwing here took passkey login down completely during a PostgREST schema
   * cache outage while enrollment kept working, because enrollment's writes
   * swallow errors and this one did not.
   *
   * Returning false makes the caller require a TOTP step-up instead. That is
   * strictly more conservative than the success path: isSessionAssured requires
   * a matching row and fails closed when absent, so a session with no row
   * already behaves as "not assured" on every subsequent request. We return the
   * same answer the system would give anyway rather than refusing service.
   */
  private async persistSessionAssurance(
    client: SupabaseClient,
    input: {
      sessionId: string;
      authUserId: string;
      expiresAt: number;
      risk: SessionRisk;
      countryCode: string | null;
    },
  ): Promise<boolean> {
    const refreshWindowSeconds =
      this.configService.get<number>('cookies.refreshMaxAge') ?? 604800;
    const assuranceExpiresAt = new Date(
      Math.max(
        input.expiresAt * 1000,
        Date.now() + refreshWindowSeconds * 1000,
      ),
    ).toISOString();
    const result = await this.supabaseAdmin
      .getClient()
      .from('auth_session_assurance')
      .upsert(
        {
          session_id: input.sessionId,
          auth_user_id: input.authUserId,
          authentication_method: 'passkey',
          user_verified: true,
          risk_level: input.risk.level,
          risk_reasons: input.risk.reasons,
          trusted_device_id: input.risk.trustedDeviceId,
          country_code: input.countryCode,
          step_up_required: input.risk.level === 'high',
          step_up_completed_at: null,
          // Bind assurance to session_id, but keep it alive across access-token
          // rotations for the browser refresh-cookie lifetime.
          expires_at: assuranceExpiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'session_id' },
      );

    if (result.error) {
      // Log the underlying PostgREST/Postgres error. Without this the operator
      // sees only the generic message and cannot tell a missing table (42P01 /
      // PGRST205) from a permission failure (42501) from a transient outage —
      // which is exactly how a production incident became undiagnosable. Every
      // other Supabase call in this file already logs its error.
      this.logger.error(
        `assurance upsert failed (session=${input.sessionId} user=${input.authUserId}): ` +
          `code=${result.error.code ?? '-'} message=${result.error.message} ` +
          `details=${result.error.details ?? '-'} hint=${result.error.hint ?? '-'}`,
      );

      // 'local', NOT 'global': this is an INFRASTRUCTURE failure, not a rejected
      // credential. The assertion itself verified. Signing the user out globally
      // would revoke their sessions on every other device because our database
      // write failed, and each retry would do it again.
      return false;
    }

    return true;
  }

  private async writeSecurityEvent(input: {
    authUserId: string | null;
    sessionId: string | null;
    eventType:
      | 'passkey_enrolled'
      | 'passkey_renamed'
      | 'passkey_deleted'
      | 'passkey_login_succeeded'
      | 'passkey_login_step_up_required'
      | 'passkey_login_rejected'
      | 'totp_step_up_completed'
      | 'trusted_device_revoked';
    authenticationMethod: 'passkey' | 'password' | 'oauth' | 'otp' | 'unknown';
    riskLevel?: 'low' | 'high';
    reasonCodes?: string[];
    deviceLabel?: string | null;
    countryCode?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.supabaseAdmin
        .getClient()
        .from('auth_security_events')
        .insert({
          auth_user_id: input.authUserId,
          session_id: input.sessionId,
          event_type: input.eventType,
          authentication_method: input.authenticationMethod,
          risk_level: input.riskLevel ?? null,
          reason_codes: input.reasonCodes ?? [],
          device_label: input.deviceLabel ?? null,
          country_code: input.countryCode ?? null,
          metadata: input.metadata ?? {},
        });
    } catch (err) {
      this.logger.warn(
        `auth_security_events insert failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async sendHighRiskNotificationOnce(input: {
    authUserId: string;
    sessionId: string;
    email: string;
    firstName: string | null;
    countryCode: string | null;
    reasons: string[];
  }): Promise<void> {
    try {
      const existing = await this.supabaseAdmin
        .getClient()
        .from('auth_security_events')
        .select('id')
        .eq('auth_user_id', input.authUserId)
        .eq('session_id', input.sessionId)
        .eq('event_type', 'passkey_login_step_up_required')
        .limit(2);

      const rows = (existing.data as Array<{ id: string }> | null) ?? [];
      if (rows.length > 1) return;

      await this.mailService.sendNotification(input.email, {
        title: 'Passkey sign-in needs extra verification',
        subject: 'Security check for your passkey sign-in',
        eyebrow: 'Security alert',
        recipientName: input.firstName ?? undefined,
        body: `A passkey sign-in requires your MFA app code before access is granted.${input.reasons.length > 0 ? ` Reason: ${input.reasons.join(', ')}.` : ''}`,
      });
    } catch (err) {
      this.logger.warn(
        `high-risk passkey notification failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * @param scope 'global' (default) for SECURITY rejections — a forged AMR, a
   * sub mismatch, an identity check that failed. There the access/refresh pair
   * must die server-side, or the credentials we just rejected stay usable.
   *
   * Pass 'local' when the session is legitimate and only OUR side failed (e.g.
   * a database write). Revoking every device over an infrastructure error
   * punishes the user for our outage.
   */
  private async bestEffortSignOut(
    client: SupabaseClient,
    scope: 'global' | 'local' = 'global',
  ): Promise<void> {
    try {
      await client.auth.signOut({ scope });
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }

  private extractExceptionMessage(error: BadRequestException): string {
    const response = error.getResponse();

    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join(', ');
    }

    return error.message;
  }
}
