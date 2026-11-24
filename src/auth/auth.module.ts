/**
 * @fileoverview Authentication module that wires together the auth controller, service, guards,
 * and dependencies. Registers {@link SupabaseAuthGuard} as the global authentication guard
 * so all routes require a valid JWT unless decorated with `@Public()`. Registers
 * {@link ActiveOrgCookieInterceptor} as the global interceptor that completes the
 * active-org cookie handshake and propagates the active organization to
 * {@link OrgContextService}.
 * @module src/auth/auth.module
 * @author Prince Jadiya
 */

import { Logger, Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { McpServiceTokenGuard } from './guards/mcp-service-token.guard';
import { TmApiKeyGuard } from './guards/tm-api-key.guard';
import { ImpersonationBlockedGuard } from './guards/impersonation-blocked.guard';
import { ImpersonationReadOnlyGuard } from './guards/impersonation-readonly.guard';
import { FeatureGuard } from './guards/feature.guard';
import { PartnerGuard } from './guards/partner.guard';
import { SsoEnforcementGuard } from './guards/sso-enforcement.guard';
import { SsoEnforcementService } from './sso-enforcement.service';
import { ActiveOrgCookieInterceptor } from './interceptors/active-org-cookie.interceptor';
import { McpServiceTokenService } from './services/mcp-service-token.service';
import { MembershipContextService } from './services/membership-context.service';
import { McpOrgContextController } from './mcp/mcp-org-context.controller';
import { McpOrgContextService } from './mcp/mcp-org-context.service';
import { McpOrgMembershipsService } from './mcp/mcp-org-memberships.service';
import { PasskeysController } from './passkeys/passkeys.controller';
import { PasskeySessionAssuranceService } from './passkeys/passkey-session-assurance.service';
import { PASSKEY_SESSION_ASSURANCE } from './passkeys/passkey-session-assurance.port';
import { PasskeysService } from './passkeys/passkeys.service';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { SpacesModule } from '../spaces/spaces.module';
import { ImpersonationModule } from '../impersonation/impersonation.module';
import { LicensingModule } from '../licensing/licensing.module';

/**
 * Module that configures authentication for the entire application.
 *
 * Imports:
 * - `JwtModule` -- provides `JwtService` for local token verification in the auth guard
 * - `UsersModule` -- provides {@link UsersService} for resolving auth user IDs to public users
 * - `MailModule` -- provides {@link MailService} for sending OTP and password reset emails
 *
 * The {@link SupabaseAuthGuard} is registered as `APP_GUARD`, making it apply globally
 * to all routes. Routes decorated with `@Public()` bypass authentication.
 *
 * The {@link ActiveOrgCookieInterceptor} is registered as `APP_INTERCEPTOR` so the
 * cookie/GUC handshake started in the guard finishes after every controller run.
 *
 * @example
 * // Import in AppModule:
 * @Module({ imports: [AuthModule] })
 * export class AppModule {}
 */
@Module({
  imports: [
    JwtModule.register({}),
    UsersModule,
    MailModule,
    // forwardRef avoids circular boot — SpacesModule transitively imports MailModule
    // which imports nothing from auth, but PermissionsModule is also imported by guards.
    forwardRef(() => PermissionsModule),
    OrganizationsModule,
    forwardRef(() => SpacesModule),
    // Provides ImpersonationService for signout best-effort stop + bootstrap
    // envelope. ImpersonationModule does not import AuthModule, so no cycle.
    ImpersonationModule,
    // Provides EntitlementsService for the global FeatureGuard + bootstrap
    // entitlements surface. LicensingModule imports nothing from auth, so no cycle.
    LicensingModule,
    // Provides OrganizationModulesService for the MCP org-context endpoint's
    // enabled-modules resolution. Imports nothing from auth, so no cycle.
    OrganizationModulesModule,
  ],
  controllers: [AuthController, McpOrgContextController, PasskeysController],
  providers: [
    AuthService,
    PasskeysService,
    PasskeySessionAssuranceService,
    {
      provide: PASSKEY_SESSION_ASSURANCE,
      useExisting: PasskeySessionAssuranceService,
    },
    // Shared membership loader, used by both SupabaseAuthGuard and the S2S guard.
    MembershipContextService,
    // Pure S2S JWT verifier (unit-testable, no DB).
    McpServiceTokenService,
    // Backs GET /auth/mcp/org-context.
    McpOrgContextService,
    // Backs GET /auth/mcp/org-memberships (MCP org.list tool).
    McpOrgMembershipsService,
    // S2S guard must run first so an S2S-authenticated request already has
    // request.user populated before SupabaseAuthGuard runs. When the S2S header
    // is absent it's a pure pass-through and SupabaseAuthGuard handles auth.
    {
      provide: APP_GUARD,
      useClass: McpServiceTokenGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TmApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    // Registered here, after SupabaseAuthGuard, so request.user is guaranteed
    // populated before these run. Within one module's providers array,
    // multi-provider order is array order, so they always run after the guard
    // declared above — no reliance on cross-module APP_GUARD ordering.
    {
      provide: APP_GUARD,
      useClass: ImpersonationBlockedGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ImpersonationReadOnlyGuard,
    },
    // Require SSO enforcement. Runs after auth + impersonation guards (so an
    // impersonation overlay and request.user are already resolved) and before
    // FeatureGuard: a member of an SSO-enforced org without an SSO session
    // binding gets 403 SSO_REQUIRED before any entitlement lookup.
    SsoEnforcementService,
    {
      provide: APP_GUARD,
      useClass: SsoEnforcementGuard,
    },
    // License-feature enforcement. Runs after auth + impersonation guards: a
    // failed auth is 401, an impersonation block is its own 403, and only then
    // do we evaluate feature entitlements (403 FEATURE_NOT_ENTITLED /
    // LICENSE_INACTIVE). request.user is guaranteed populated by
    // SupabaseAuthGuard above.
    {
      provide: APP_GUARD,
      useClass: FeatureGuard,
    },
    // Partner-org enforcement. Declared LAST: a no-op unless the route carries
    // @RequirePartner(), in which case it asserts organizations.is_partner for
    // request.user.organizationId. Ordered after FeatureGuard so the cheaper
    // entitlement check fails first and we only pay this guard's DB round-trip
    // on requests that are otherwise allowed.
    //
    // This registration IS the partner authorization boundary. @RequirePartner()
    // is a bare SetMetadata — without this provider the decorator is inert
    // metadata and the partner controllers fall back to permission checks alone.
    // Do not remove it and do not reorder it above SupabaseAuthGuard.
    {
      provide: APP_GUARD,
      useClass: PartnerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ActiveOrgCookieInterceptor,
    },
  ],
  exports: [
    AuthService,
    PasskeysService,
    PasskeySessionAssuranceService,
    PASSKEY_SESSION_ASSURANCE,
  ],
})
export class AuthModule implements OnModuleInit {
  private static readonly bootLogger = new Logger('AuthModule');

  constructor(private readonly configService: ConfigService) {}

  /**
   * One-time boot diagnostics. We warn loudly when COOKIE_SIGNING_SECRET was
   * not set — the active-org cookie helpers fall back to SUPABASE_JWT_SECRET,
   * which works but couples cookie integrity to JWT signing. Operators should
   * set a dedicated secret in production so rotating one does not invalidate
   * the other.
   */
  onModuleInit(): void {
    const isFallback = this.configService.get<boolean>(
      'cookies.signingSecretIsFallback',
    );
    const secret = this.configService.get<string>('cookies.signingSecret');

    if (!secret) {
      AuthModule.bootLogger.error(
        'COOKIE_SIGNING_SECRET and SUPABASE_JWT_SECRET are both unset — active_org_id cookie will NOT be issued. Set COOKIE_SIGNING_SECRET (≥32 chars).',
      );
      return;
    }

    if (isFallback) {
      AuthModule.bootLogger.warn(
        'COOKIE_SIGNING_SECRET is not set; active_org_id cookie is being signed with SUPABASE_JWT_SECRET. Consider setting a dedicated secret so rotating one does not invalidate the other.',
      );
    }

    const cookieDomain = this.configService.get<string>('cookies.domain');

    if (process.env.NODE_ENV === 'production' && !cookieDomain) {
      AuthModule.bootLogger.warn(
        'COOKIE_DOMAIN is unset in production — cross-subdomain auth and impersonation overlays require COOKIE_DOMAIN=.{root} (e.g. .xisuite.cloud) so cookies are shared between frontend and backend subdomains.',
      );
    }
  }
}
