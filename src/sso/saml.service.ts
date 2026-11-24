/**
 * @fileoverview SP-initiated SAML login broker (XE-T346).
 *
 * The IdP proves who the person is; the session is then minted for that
 * person's EXISTING auth user through `generateLink` + `verifyOtp`, and bound
 * to the connection's workspace so Require SSO can recognise it.
 *
 * Every login is gated inside the connection's organization: the account's
 * email domain must be verified AND bound to this connection, owners can only
 * sign in through a connection an owner vouched for, and SCIM-deactivated or
 * globally inactive accounts are refused. A refusal never mints a session.
 *
 * @module src/sso/saml.service
 * @author Prince Jadiya
 */

import {
  ForbiddenException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SAML,
  ValidateInResponseTo,
  type CacheProvider,
  type Profile,
} from '@node-saml/node-saml';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { TokenResponse } from '../auth/interfaces/auth-response.interface';
import { getSessionAssuranceTokenPayload } from '../auth/mfa/session-assurance.util';
import { OauthService } from '../auth/oauth/oauth.service';
import { isAllowedConfiguredOrSubdomainOrigin } from '../common/cors/site-studio-cors.util';
import { OnPremiseTenantService } from '../on-premise/on-premise-tenant.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UsersService, type PublicUser } from '../users/users.service';
import { SsoAccountsService } from './sso-accounts.service';
import { getSamlSpBaseUrl, getSamlSpUrls } from './sso-urls';

/** HttpOnly cookie tying the ACS POST to the browser that started the login. */
export const SAML_REQUEST_COOKIE = 'saml_request';

/** Lifetime of an AuthnRequest (DB row, node-saml check and cookie). */
export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;

/** node-saml has no size limit; refuse anything larger before decoding. */
export const SAML_RESPONSE_MAX_LENGTH = 512_000;

const EMAIL_CLAIM =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const GIVEN_NAME_CLAIM =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname';
const SURNAME_CLAIM =
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CONNECTION_COLUMNS =
  'id, organization_id, idp_entity_id, idp_sso_url, idp_certs, is_enabled, jit_enabled, trust_updated_by';

/** Codes the login page understands (`/auth/login?error=<code>`). */
export type SamlLoginErrorCode =
  | 'sso_assertion_invalid'
  | 'sso_connection_disabled'
  | 'sso_no_workspace_access'
  | 'sso_account_inactive'
  | 'sso_seat_limit';

/** A refused SAML login. Only the code ever reaches the browser. */
export class SamlLoginError extends Error {
  constructor(readonly code: SamlLoginErrorCode) {
    super(code);
  }
}

interface ISamlConnection {
  id: string;
  organization_id: string;
  idp_entity_id: string;
  idp_sso_url: string;
  idp_certs: string[];
  is_enabled: boolean;
  jit_enabled: boolean;
  trust_updated_by: string | null;
}

/** Result of a successful ACS round-trip. */
export interface ISamlLoginResult {
  tokens: TokenResponse;
  redirectTo: string;
  organizationId: string;
}

type DbCacheProvider = CacheProvider & { lastKey: string | null };

type SubjectAssertion = {
  Assertion?: {
    Subject?: Array<{
      SubjectConfirmation?: Array<{
        SubjectConfirmationData?: Array<{ $?: { InResponseTo?: unknown } }>;
      }>;
    }>;
  };
};

@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
    private readonly accounts: SsoAccountsService,
    private readonly usersService: UsersService,
    private readonly oauthService: OauthService,
    private readonly onPremiseTenant: OnPremiseTenantService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Frontend origin without a trailing slash. */
  frontendUrl(): string {
    return (
      this.configService.get<string>('frontendUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /**
   * Starts an SP-initiated login: stores the AuthnRequest and returns the IdP
   * URL plus the browser-binding cookie value.
   *
   * @param {string} connectionId - `sso_connections.id`
   * @param {string} [redirectTo] - Frontend URL to land on; unsafe values fall back to FRONTEND_URL
   * @throws {SamlLoginError} `sso_connection_disabled` when missing or disabled
   */
  async startLogin(
    connectionId: string,
    redirectTo: string | undefined,
  ): Promise<{ url: string; requestCookie: string }> {
    const connection = await this.loadConnection(connectionId);

    if (!connection?.is_enabled) {
      throw new SamlLoginError('sso_connection_disabled');
    }

    const cache = this.createCacheProvider(
      connection,
      this.safeRedirect(redirectTo),
    );
    const url = await this.buildSaml(connection, cache).getAuthorizeUrlAsync(
      '',
      undefined,
      {},
    );

    if (!cache.lastKey) {
      throw new Error('SAML AuthnRequest id was not stored');
    }

    return { url, requestCookie: this.signRequestId(cache.lastKey) };
  }

  /**
   * Validates a SAMLResponse, gates the account and mints a bound session.
   *
   * @param {string} connectionId - `sso_connections.id` from the ACS URL
   * @param {unknown} samlResponse - The posted `SAMLResponse` field
   * @param {string} [requestCookie] - The `saml_request` cookie
   * @throws {SamlLoginError} On every refusal; nothing is minted
   */
  async completeLogin(
    connectionId: string,
    samlResponse: unknown,
    requestCookie: string | undefined,
  ): Promise<ISamlLoginResult> {
    if (
      typeof samlResponse !== 'string' ||
      !samlResponse ||
      samlResponse.length > SAML_RESPONSE_MAX_LENGTH
    ) {
      throw new SamlLoginError('sso_assertion_invalid');
    }

    const connection = await this.loadConnection(connectionId);

    if (!connection?.is_enabled) {
      throw new SamlLoginError('sso_connection_disabled');
    }

    const { profile, inResponseTo } = await this.validateResponse(
      connection,
      samlResponse,
      requestCookie,
    );
    const redirectTo = await this.consumeRequest(connection, inResponseTo);
    const user = await this.resolveAccount(connection, profile);
    const authUserId = await this.conflictAsNoAccess(() =>
      this.accounts.ensureAuthUser(user),
    );
    const tokens = await this.mintSession(authUserId);

    await this.bindSession(connection, authUserId, tokens);

    // Same on-prem auto-join the OAuth callback runs; no-op off-premise.
    try {
      await this.onPremiseTenant.ensureDefaultMembership(user.id, user.email);
    } catch (err) {
      this.logger.warn(`SAML auto-join skipped: ${errorMessage(err)}`);
    }

    return { tokens, redirectTo, organizationId: connection.organization_id };
  }

  /**
   * SP metadata XML for the IdP. Served for disabled connections too, so an
   * admin can configure the IdP before enabling.
   *
   * @returns {Promise<string | null>} XML, or null when the connection does not exist
   */
  async metadata(connectionId: string): Promise<string | null> {
    const connection = await this.loadConnection(connectionId);

    if (!connection) return null;

    return this.buildSaml(
      connection,
      this.createCacheProvider(connection, ''),
    ).generateServiceProviderMetadata(null, null);
  }

  /**
   * Finds the enabled connection for an email's verified, bound domain.
   *
   * @param {unknown} email - Untrusted request body value
   * @returns {Promise<string | null>} The connection id, or null
   */
  async discover(email: unknown): Promise<string | null> {
    if (typeof email !== 'string' || email.length > 320) return null;

    const domain = this.accounts.emailDomain(email);

    if (!domain) return null;

    const client = this.supabaseAdmin.getClient();
    // Public route: the org comes from the domain row, never from a request.
    const { data: domainRow, error: domainError } = await client
      .from('sso_domains')
      .select('organization_id, connection_id')
      .eq('domain', domain)
      .not('verified_at', 'is', null)
      .not('connection_id', 'is', null)
      .maybeSingle();

    if (domainError || !domainRow) return null;

    const row = domainRow as { organization_id: string; connection_id: string };
    const { data: connection } = await client
      .from('sso_connections')
      .select('id')
      .eq('id', row.connection_id)
      .eq('organization_id', row.organization_id)
      .eq('is_enabled', true)
      .maybeSingle();

    return (connection as { id: string } | null)?.id ?? null;
  }

  /** HMAC of an AuthnRequest id, the value of the `saml_request` cookie. */
  signRequestId(requestId: string): string {
    const secret = this.configService.get<string>('sessionSigningSecret');

    if (!secret) {
      throw new Error('sessionSigningSecret is not configured');
    }

    return createHmac('sha256', secret).update(requestId).digest('hex');
  }

  private async loadConnection(
    connectionId: string,
  ): Promise<ISamlConnection | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('sso_connections')
      .select(CONNECTION_COLUMNS)
      .eq('id', connectionId)
      .maybeSingle();

    if (error) {
      throw new Error(`sso_connections lookup failed: ${error.message}`);
    }

    return data as ISamlConnection | null;
  }

  private safeRedirect(redirectTo: string | undefined): string {
    if (
      redirectTo &&
      isAllowedConfiguredOrSubdomainOrigin(
        redirectTo,
        this.oauthService.frontendAllowlist(),
      )
    ) {
      return redirectTo;
    }

    return this.frontendUrl();
  }

  /** A fresh node-saml instance per request, built from the connection row. */
  private buildSaml(
    connection: ISamlConnection,
    cacheProvider: CacheProvider,
  ): SAML {
    const { spEntityId, acsUrl } = getSamlSpUrls(
      getSamlSpBaseUrl(this.configService),
      connection.id,
    );

    return new SAML({
      entryPoint: connection.idp_sso_url,
      issuer: spEntityId,
      audience: spEntityId,
      callbackUrl: acsUrl,
      idpCert: connection.idp_certs,
      idpIssuer: connection.idp_entity_id,
      wantAssertionsSigned: true,
      // Entra signs only the assertion by default.
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
      acceptedClockSkewMs: 180_000,
      // Avoids Entra AADSTS75011 for MFA/passwordless sign-ins.
      disableRequestedAuthnContext: true,
      cacheProvider,
    });
  }

  /**
   * node-saml request cache backed by `saml_requests`. Reads never delete:
   * node-saml reads the same id twice. The ACS consumes the row atomically
   * after validation instead, which also closes the concurrent-replay race.
   */
  private createCacheProvider(
    connection: ISamlConnection,
    redirectTo: string,
  ): DbCacheProvider {
    const client = this.supabaseAdmin.getClient();
    const orgId = connection.organization_id;
    const provider: DbCacheProvider = {
      lastKey: null,
      saveAsync: async (key, value) => {
        const now = Date.now();

        await client
          .from('saml_requests')
          .delete()
          .eq('organization_id', orgId)
          .lt('expires_at', new Date(now).toISOString());

        const { error } = await client.from('saml_requests').insert({
          id: key,
          organization_id: orgId,
          connection_id: connection.id,
          value,
          redirect_to: redirectTo,
          expires_at: new Date(now + SAML_REQUEST_TTL_MS).toISOString(),
        });

        if (error) {
          throw new Error(`saml_requests insert failed: ${error.message}`);
        }

        provider.lastKey = key;

        return { value, createdAt: now };
      },
      getAsync: async (key) => {
        const { data, error } = await client
          .from('saml_requests')
          .select('value')
          .eq('id', key)
          .eq('connection_id', connection.id)
          .eq('organization_id', orgId)
          .gt('expires_at', new Date().toISOString())
          .maybeSingle();

        if (error) {
          throw new Error(`saml_requests lookup failed: ${error.message}`);
        }

        return (data as { value: string } | null)?.value ?? null;
      },
      removeAsync: (key) => Promise.resolve(key),
    };

    return provider;
  }

  private async validateResponse(
    connection: ISamlConnection,
    samlResponse: string,
    requestCookie: string | undefined,
  ): Promise<{ profile: Profile; inResponseTo: string }> {
    let result: { profile: Profile | null; loggedOut: boolean };

    try {
      result = await this.buildSaml(
        connection,
        this.createCacheProvider(connection, ''),
      ).validatePostResponseAsync({ SAMLResponse: samlResponse });
    } catch (err) {
      // Library messages name issuers and ids: log them, never put them in a URL.
      throw this.invalid(connection, errorMessage(err));
    }

    const { profile, loggedOut } = result;

    if (!profile || loggedOut) {
      throw this.invalid(connection, 'no login profile in the response');
    }

    if (profile.issuer !== connection.idp_entity_id) {
      throw this.invalid(connection, 'assertion issuer mismatch');
    }

    const inResponseTo = profile.inResponseTo;

    if (typeof inResponseTo !== 'string' || !inResponseTo) {
      throw this.invalid(connection, 'response has no InResponseTo');
    }

    // node-saml tolerates a subject confirmation without InResponseTo; a
    // re-wrapped assertion from another login must not pass.
    const subjectIds = subjectInResponseTo(profile);

    if (!subjectIds.length || subjectIds.some((id) => id !== inResponseTo)) {
      throw this.invalid(connection, 'subject InResponseTo mismatch');
    }

    const expected = Buffer.from(this.signRequestId(inResponseTo));
    const actual = Buffer.from(requestCookie ?? '');

    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw this.invalid(connection, 'saml_request cookie mismatch');
    }

    return { profile, inResponseTo };
  }

  private async consumeRequest(
    connection: ISamlConnection,
    requestId: string,
  ): Promise<string> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('saml_requests')
      .delete()
      .eq('id', requestId)
      .eq('connection_id', connection.id)
      .eq('organization_id', connection.organization_id)
      .gt('expires_at', new Date().toISOString())
      .select('redirect_to');
    const row = (data as { redirect_to: string }[] | null)?.[0];

    if (error || !row) {
      throw this.invalid(connection, 'AuthnRequest already used or expired');
    }

    return row.redirect_to;
  }

  /** Resolves the account and applies every login gate (see plan defaults). */
  private async resolveAccount(
    connection: ISamlConnection,
    profile: Profile,
  ): Promise<PublicUser> {
    const orgId = connection.organization_id;
    const client = this.supabaseAdmin.getClient();
    const nameId =
      typeof profile.nameID === 'string'
        ? profile.nameID.trim().toLowerCase()
        : '';
    const rawEmail =
      readClaim(profile, EMAIL_CLAIM) ??
      readClaim(profile, 'email') ??
      readClaim(profile, 'mail') ??
      nameId;
    const email = EMAIL_SHAPE.test(rawEmail)
      ? this.accounts.normalizeEmail(rawEmail)
      : null;
    const userNames = [...new Set([nameId, email].filter(Boolean))] as string[];

    let user: PublicUser | null = null;

    if (userNames.length) {
      // Tombstoned links are included on purpose: they drive the inactive refusal.
      const { data: links, error } = await client
        .from('scim_links')
        .select('local_user_id, user_name')
        .eq('organization_id', orgId)
        .eq('resource_type', 'User')
        .in('user_name', userNames);

      if (error) throw new Error(`scim_links lookup failed: ${error.message}`);

      const rows = (links ?? []) as {
        local_user_id: string;
        user_name: string;
      }[];
      const link = rows.find((r) => r.user_name === nameId) ?? rows[0];

      if (link) user = await this.usersService.getUserById(link.local_user_id);
    }

    if (!user && email) user = await this.accounts.findUserByEmail(email);

    if (!user) {
      if (
        !email ||
        !connection.jit_enabled ||
        !(await this.accounts.isDomainBoundToConnection(
          orgId,
          connection.id,
          email,
        ))
      ) {
        throw new SamlLoginError('sso_no_workspace_access');
      }

      const names = {
        firstName: readClaim(profile, GIVEN_NAME_CLAIM),
        lastName: readClaim(profile, SURNAME_CLAIM),
      };
      // Refuse BEFORE creating the account, so a full workspace leaves no
      // orphan user behind.
      await this.seatOrRefuse(() =>
        this.accounts.assertSeatForNewMember(orgId, null, email),
      );

      const created = await this.conflictAsNoAccess(() =>
        this.accounts.createAccount(email, names),
      );

      await this.accounts.attachMember(orgId, created.id, created.email);

      return created;
    }

    if (
      !(await this.accounts.isDomainBoundToConnection(
        orgId,
        connection.id,
        user.email,
      ))
    ) {
      throw new SamlLoginError('sso_no_workspace_access');
    }

    const role = await this.accounts.getMemberRole(orgId, user.id);

    if (role === 'owner') {
      // A SCIM link's user_name can be repointed by a non-owner token, so an
      // owner is only ever matched by the email the IdP actually asserted.
      const accountEmail = this.accounts.normalizeEmail(user.email);
      const emailMatches =
        accountEmail === email ||
        (EMAIL_SHAPE.test(nameId) && accountEmail === nameId);

      if (
        !emailMatches ||
        !(await this.accounts.isCurrentOwner(
          orgId,
          connection.trust_updated_by,
        ))
      ) {
        await this.auditLogs.logSystemAction(
          orgId,
          'sso_connection',
          connection.id,
          'update',
          {
            event: 'sso_owner_login_blocked',
            reason: emailMatches
              ? 'trust_not_owner'
              : 'assertion_email_mismatch',
            user_id: user.id,
            trust_updated_by: connection.trust_updated_by,
          },
        );

        throw new SamlLoginError('sso_no_workspace_access');
      }
    }

    if (!role) {
      const { data: link, error } = await client
        .from('scim_links')
        .select('is_active, deleted_at')
        .eq('organization_id', orgId)
        .eq('local_user_id', user.id)
        .maybeSingle();

      if (error) throw new Error(`scim_links lookup failed: ${error.message}`);

      const scim = link as { is_active: boolean; deleted_at: string | null };

      if (scim && (!scim.is_active || scim.deleted_at)) {
        throw new SamlLoginError('sso_account_inactive');
      }
    }

    if (user.is_active === false) {
      throw new SamlLoginError('sso_account_inactive');
    }

    if (!role) {
      if (!connection.jit_enabled) {
        throw new SamlLoginError('sso_no_workspace_access');
      }

      await this.seatOrRefuse(() =>
        this.accounts.attachMember(orgId, user.id, user.email, 'member'),
      );
    }

    return user;
  }

  /** A seat-limit refusal becomes a login error the login page can explain. */
  private async seatOrRefuse(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new SamlLoginError('sso_seat_limit');
      }
      throw err;
    }
  }

  /**
   * Mints a session for an existing auth user. The magic link is generated
   * for that user's own email and its user id re-checked, because
   * `generateLink` silently CREATES a user for an unknown email.
   */
  private async mintSession(authUserId: string): Promise<TokenResponse> {
    const admin = this.supabaseAdmin.getClient().auth.admin;
    const { data: found, error: findError } =
      await admin.getUserById(authUserId);
    const email = found?.user?.email;

    if (findError || !email) {
      throw new SamlLoginError('sso_assertion_invalid');
    }

    const { data: link, error: linkError } = await admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (
      linkError ||
      link?.user?.id !== authUserId ||
      !link.properties?.hashed_token
    ) {
      this.logger.warn(`SAML magic link did not match auth user ${authUserId}`);
      throw new SamlLoginError('sso_assertion_invalid');
    }

    const { data: verified, error: verifyError } = await this.supabaseAdmin
      .createAuthClient()
      .auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: (link.properties.verification_type ??
          'magiclink') as EmailOtpType,
      });
    const session = verified?.session;

    if (verifyError || !session) {
      this.logger.warn(
        `SAML session verification failed for auth user ${authUserId}: ${verifyError?.message ?? 'no session'}`,
      );
      throw new SamlLoginError('sso_assertion_invalid');
    }

    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      token_type: 'bearer',
    };
  }

  /**
   * Records that this session came through the workspace's SSO, and carries
   * the same auth user's other live SSO workspaces onto it (Q7). On failure
   * the fresh session is revoked, so an unbound session never escapes.
   */
  private async bindSession(
    connection: ISamlConnection,
    authUserId: string,
    tokens: TokenResponse,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();

    try {
      const sessionId = getSessionAssuranceTokenPayload(
        tokens.access_token,
      )?.session_id;

      if (typeof sessionId !== 'string' || !sessionId) {
        throw new Error('access token has no session_id');
      }

      const now = Date.now();
      const refreshSeconds =
        this.configService.get<number>('cookies.refreshMaxAge') ?? 604800;
      const expiresAt = new Date(
        Math.max(now + tokens.expires_in * 1000, now + refreshSeconds * 1000),
      ).toISOString();
      const { error } = await client.from('sso_session_bindings').upsert(
        {
          session_id: sessionId,
          organization_id: connection.organization_id,
          connection_id: connection.id,
          auth_user_id: authUserId,
          expires_at: expiresAt,
        },
        { onConflict: 'session_id,organization_id' },
      );

      if (error) throw new Error(`binding upsert failed: ${error.message}`);

      // Scoped by the authenticated auth user, not one org: these are the
      // user's own bindings in the other workspaces they already SSO'd into.
      const { data: others, error: othersError } = await client
        .from('sso_session_bindings')
        .select('organization_id, connection_id, expires_at')
        .eq('auth_user_id', authUserId)
        .gt('expires_at', new Date(now).toISOString())
        .neq('session_id', sessionId);

      if (othersError) {
        throw new Error(`binding lookup failed: ${othersError.message}`);
      }

      const latest = new Map<
        string,
        { organization_id: string; connection_id: string; expires_at: string }
      >();

      for (const row of (others ?? []) as {
        organization_id: string;
        connection_id: string;
        expires_at: string;
      }[]) {
        const prev = latest.get(row.organization_id);

        if (
          row.organization_id !== connection.organization_id &&
          (!prev || Date.parse(prev.expires_at) < Date.parse(row.expires_at))
        ) {
          latest.set(row.organization_id, row);
        }
      }

      if (latest.size) {
        const { error: copyError } = await client
          .from('sso_session_bindings')
          .upsert(
            [...latest.values()].map((row) => ({
              ...row,
              session_id: sessionId,
              auth_user_id: authUserId,
            })),
            {
              onConflict: 'session_id,organization_id',
              ignoreDuplicates: true,
            },
          );

        if (copyError) {
          throw new Error(`binding copy failed: ${copyError.message}`);
        }
      }
    } catch (err) {
      this.logger.warn(
        `SSO session binding failed for connection ${connection.id}: ${errorMessage(err)}`,
      );

      await this.revokeSession(tokens.access_token);

      throw new SamlLoginError('sso_assertion_invalid');
    }
  }

  /**
   * Best-effort revoke of one freshly minted session. 'local' revokes only
   * this session, never the user's other devices. Never throws.
   */
  async revokeSession(accessToken: string): Promise<void> {
    try {
      await this.supabaseAdmin
        .getClient()
        .auth.admin.signOut(accessToken, 'local');
    } catch (err) {
      this.logger.warn(`SSO session revoke failed: ${errorMessage(err)}`);
    }
  }

  private async conflictAsNoAccess<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConflictException) {
        throw new SamlLoginError('sso_no_workspace_access');
      }

      throw err;
    }
  }

  private invalid(connection: ISamlConnection, reason: string): SamlLoginError {
    this.logger.warn(
      `SAML response rejected for connection ${connection.id}: ${reason}`,
    );

    return new SamlLoginError('sso_assertion_invalid');
  }
}

/** First non-empty string value of a profile attribute. */
function readClaim(profile: Profile, key: string): string | null {
  const raw = profile[key];
  const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Every `SubjectConfirmationData@InResponseTo` in the validated assertion. */
function subjectInResponseTo(profile: Profile): unknown[] {
  const doc = profile.getAssertion?.() as SubjectAssertion | undefined;
  const confirmations = doc?.Assertion?.Subject?.[0]?.SubjectConfirmation ?? [];

  return confirmations.map(
    (confirmation) =>
      confirmation.SubjectConfirmationData?.[0]?.$?.InResponseTo,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
