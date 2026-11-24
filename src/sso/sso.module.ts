import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { OauthModule } from '../auth/oauth/oauth.module';
import { LicensingModule } from '../licensing/licensing.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UserGroupsModule } from '../user-groups/user-groups.module';
import { UsersModule } from '../users/users.module';
import { SamlController } from './saml.controller';
import { SamlService } from './saml.service';
import { ScimTokenGuard } from './scim-token.guard';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';
import { SsoAccountsService } from './sso-accounts.service';
import { SsoAdminController } from './sso-admin.controller';
import { SsoAdminService } from './sso-admin.service';

/**
 * SAML single sign-on, SCIM provisioning and SSO administration (XE-T346).
 *
 * - {@link SsoAdminController}: owner/admin configuration of connections, domains,
 *   SCIM tokens and Require SSO.
 * - {@link SamlController}: public SP-initiated SAML login, ACS and SP metadata.
 * - {@link ScimController}: SCIM 2.0 `/Users` and `/Groups` for Microsoft Entra ID.
 *
 * Require SSO itself is enforced by `SsoEnforcementGuard`, registered in AuthModule.
 */
@Module({
  imports: [
    AuthModule,
    OauthModule,
    UsersModule,
    UserGroupsModule,
    PermissionsModule,
    AuditLogsModule,
    // EntitlementsService for switching Require SSO on (not exported by AuthModule).
    LicensingModule,
  ],
  controllers: [SsoAdminController, SamlController, ScimController],
  providers: [
    SsoAdminService,
    SamlService,
    ScimService,
    ScimTokenGuard,
    SsoAccountsService,
  ],
})
export class SsoModule {}
