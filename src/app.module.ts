import { SlaModule } from './sla/sla.module';
/**
 * @fileoverview Root application module that wires together all feature modules, global configuration,
 * and rate limiting. This is the single entry point for the NestJS dependency injection container.
 * @module src/app.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { UserAwareThrottlerGuard } from './common/throttler/user-aware-throttler.guard';
import { ImpersonationContextInterceptor } from './common/interceptors/impersonation-context.interceptor';
import { MultipartEncodingModule } from './common/multipart-encoding.module';
import { AppController } from './app.controller';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { MfaModule } from './auth/mfa/mfa.module';
import { OauthModule } from './auth/oauth/oauth.module';
import { PermissionsModule } from './permissions/permissions.module';
import { InvitationsModule } from './invitations/invitations.module';
import { AdminTenantsModule } from './admin-tenants/admin-tenants.module';
import { ImpersonationModule } from './impersonation/impersonation.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { TenantsModule } from './tenants/tenants.module';
import { OrgTimeSettingsModule } from './org-time-settings/org-time-settings.module';
import { UserTimeSettingsModule } from './user-time-settings/user-time-settings.module';
import { SpacesModule } from './spaces/spaces.module';
import { SpaceOverviewModule } from './spaces/overview/space-overview.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { HierarchyConfigModule } from './hierarchy-config/hierarchy-config.module';
import { TaskHierarchyConfigModule } from './task-hierarchy-config/task-hierarchy-config.module';
import { TaskTypeFormAssignmentsModule } from './task-type-form-assignments/task-type-form-assignments.module';
import { TaskStatusesModule } from './task-statuses/task-statuses.module';
import { StatusCategoriesModule } from './status-categories/status-categories.module';
import { ResolutionsModule } from './resolutions/resolutions.module';
import { WorkflowEngineModule } from './workflow-engine/workflow-engine.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { WorkflowTransitionsModule } from './workflow-transitions/workflow-transitions.module';
import { WorkflowAssignmentsModule } from './workflow-assignments/workflow-assignments.module';
import { WorkflowOutboxModule } from './workflow-outbox/workflow-outbox.module';
import { WorkflowCronModule } from './workflow-cron/workflow-cron.module';
import { WorkflowTriggersModule } from './workflow-triggers/workflow-triggers.module';
import { GitTriggersModule } from './git-triggers/git-triggers.module';
import { WorkflowGithubModule } from './workflow-github/workflow-github.module';
import { GitIntegrationsModule } from './git-integrations/git-integrations.module';
import { CiServersModule } from './ci-servers/ci-servers.module';
import { TaskPrioritiesModule } from './task-priorities/task-priorities.module';
import { RelationTypesModule } from './relation-types/relation-types.module';
import { TasksModule } from './tasks/tasks.module';
import { ProcessesModule } from './processes/processes.module';
import { BoardsModule } from './boards/boards.module';
import { ListsModule } from './lists/lists.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { WikiModule } from './wiki/wiki.module';
import { ChatModule } from './chat/chat.module';
import { ChatAgentModule } from './chat-agent/chat-agent.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { GdprModule } from './gdpr/gdpr.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HeatmapModule } from './heatmap/heatmap.module';
import { RiskConfigurationModule } from './risk-configuration/risk-configuration.module';
import { CalculationsModule } from './calculations/calculations.module';
import { UserGroupsModule } from './user-groups/user-groups.module';
import { CustomRolesModule } from './custom-roles/custom-roles.module';
import { SpaceOverridesModule } from './space-overrides/space-overrides.module';
import { SpaceTypesModule } from './space-types/space-types.module';
import { SavedFiltersModule } from './saved-filters/saved-filters.module';
import { FilterExportsModule } from './filter-exports/filter-exports.module';
import { AssetsModule } from './assets/assets.module';
import { SprintsModule } from './sprints/sprints.module';
import { BoardPermissionsModule } from './board-permissions/board-permissions.module';
import { SwimlanesModule } from './swimlanes/swimlanes.module';
import { CardFieldsModule } from './card-fields/card-fields.module';
import { QuickFiltersModule } from './quick-filters/quick-filters.module';
import { AiConfigModule } from './ai-config/ai-config.module';
import { PlansModule } from './plans/plans.module';
import { OrganizationModulesModule } from './organization-modules/organization-modules.module';
import { McpSettingsModule } from './mcp-settings/mcp-settings.module';
import { OrganizationAuthProvidersModule } from './organization-auth-providers/organization-auth-providers.module';
import { LicensingModule } from './licensing/licensing.module';
import { PortfoliosModule } from './portfolios/portfolios.module';
import { PartnerModule } from './partner/partner.module';
import { PortfolioSavedViewsModule } from './portfolio-saved-views/portfolio-saved-views.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { ActiveTimersModule } from './active-timers/active-timers.module';
import { UploadsModule } from './uploads/uploads.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { FunnelsModule } from './site-studio/funnels/funnels.module';
import { PagesModule } from './site-studio/pages/pages.module';
import { ContactsModule } from './site-studio/contacts/contacts.module';
import { FormFieldsModule } from './site-studio/form-fields/form-fields.module';
import { DomainsModule } from './site-studio/domains/domains.module';
import { MediaModule } from './site-studio/media/media.module';
import { SubmitModule } from './site-studio/submit/submit.module';
import { PublicSiteStudioModule } from './site-studio/public/public-site-studio.module';
import { PublicFormModule } from './site-studio/public-form/public-form.module';
import { SiteTemplatesModule } from './site-studio/templates/site-templates.module';
import { PublicFormBuilderModule } from './form-builder/public/public-form-builder.module';
import { StripePaymentsModule } from './stripe/stripe.module';
import { AutomationsModule } from './automations/automations.module';
import { InboundEmailModule } from './inbound-email/inbound-email.module';
import { AiAutomationModule } from './ai-automation/ai-automation.module';
import { ResourcePlanningModule } from './resource-planning/resource-planning.module';
import { ResourceScheduleSavedViewsModule } from './resource-schedule-saved-views/resource-schedule-saved-views.module';
import { AssetsObjectsModule } from './assets-objects/assets-objects.module';
import { FileExplorerModule } from './file-explorer/file-explorer.module';
import { HelpCenterModule } from './help-center/help-center.module';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { StorageConfigModule } from './storage-config/storage-config.module';
import { TaskSidebarPreferencesModule } from './task-sidebar-preferences/task-sidebar-preferences.module';
import { OnPremLicenseModule } from './on-prem-license/on-prem-license.module';
import { OnPremUpdatesModule } from './on-prem-updates/on-prem-updates.module';
import { OnPremConfigModule } from './on-prem-config/on-prem-config.module';
import { SystemMetricsModule } from './system-metrics/system-metrics.module';
import { OnPremiseModule } from './on-premise/on-premise.module';
import { OnpremReleasesModule } from './onprem-releases/onprem-releases.module';
import { SpaceTemplatesModule } from './space-templates/space-templates.module';
import { FormBuilderModule } from './form-builder/form-builder.module';
import { WhiteboardsModule } from './whiteboards/whiteboards.module';
import { TestManagementModule } from './test-management/test-management.module';
import { MigrationModule } from './migration/migration.module';
import { DocumentDesignerModule } from './document-designer/document-designer.module';
import { CalendarModule } from './calendar/calendar.module';
import { BackupModule } from './backup/backup.module';
import { SsoModule } from './sso/sso.module';

/**
 * On-premise deployment flag, evaluated at module-eval time (before NestFactory).
 * When false (the SaaS default), OnPremUpdatesModule is NEVER imported, so none
 * of its routes are registered — the feature is invisible by ABSENCE, not by a
 * runtime filter. The deployer renders IS_ON_PREMISE=true only on self-hosted
 * stacks. Mirror of configuration.ts `onPrem.enabled`.
 */
const IS_ON_PREMISE = ['true', '1', 'yes'].includes(
  (process.env.IS_ON_PREMISE || '').trim().toLowerCase(),
);

/**
 * Root module of the XISUITE backend application.
 *
 * Imports:
 * - `ConfigModule` (global) -- loads environment variables via {@link configuration} and validates them with {@link validateEnv}
 * - `ThrottlerModule` -- applies a default rate limit of 100 requests per 60 seconds
 * - `SupabaseModule` -- global Supabase client providers
 * - `AuthModule` -- authentication and JWT guard
 * - `PermissionsModule` -- RBAC permission resolution
 * - `InvitationsModule` -- organization/space invitation CRUD
 *
 * The `ThrottlerGuard` is registered as a global guard via `APP_GUARD`.
 *
 * @example
 * // Used by NestFactory in main.ts:
 * const app = await NestFactory.create(AppModule);
 */
@Module({
  imports: [
    SlaModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),

    // Decode multipart filenames as UTF-8 instead of multer's latin1 default, app-wide. Without it
    // every non-ASCII upload name is persisted mojibaked ("Gründung" -> "GrÃ¼ndung").
    MultipartEncodingModule,
    // Env-driven throttle config. `THROTTLE_TTL` is the window in ms,
    // `THROTTLE_LIMIT` is the cap per tracker key. The tracker key is supplied
    // by UserAwareThrottlerGuard (per-user when authenticated, per-IP otherwise),
    // so the limit is per-user for logged-in traffic — not shared across users
    // behind a reverse proxy. Per-route @Throttle decorators override this.
    //
    // STORAGE: in-memory by default, Redis when REDIS_URL is set.
    //
    // In-memory storage is PER-PROCESS, so N workers silently multiply the
    // effective limit by N — a rate limiter that quietly stops limiting is worse
    // than none, because nothing surfaces the change. Redis makes the counter
    // shared, and is therefore a prerequisite for ever running more than one
    // backend process.
    //
    // The fallback is deliberate and must stay. This product also ships
    // ON-PREMISE, where operators may not run Redis; making REDIS_URL mandatory
    // would turn "unset config" into "server won't boot" and break every existing
    // single-process deployment. Unset simply keeps today's behaviour, which is
    // correct for a single process. Redis becomes REQUIRED only once you actually
    // cluster — that is a deployment decision, not a code default.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = process.env.REDIS_URL;

        return {
          throttlers: [
            {
              name: 'default',
              ttl: config.get<number>('throttle.ttl') ?? 60000,
              limit: config.get<number>('throttle.limit') ?? 100,
            },
          ],
          ...(redisUrl ? { storage: new RedisThrottlerStorage(redisUrl) } : {}),
        };
      },
    }),
    // The schedule + event-emitter roots must register at the top of the
    // module graph so the outbox processor's `@Cron` decorator and the
    // engine's `EventEmitter2` injection work everywhere. Nest dedupes
    // forRoot() calls from feature modules so importing here is safe.
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    SupabaseModule,
    AuthModule,
    MfaModule,
    OauthModule,
    PermissionsModule,
    InvitationsModule,
    AdminTenantsModule,
    ImpersonationModule,
    UsersModule,
    OrganizationsModule,
    TenantsModule,
    OrgTimeSettingsModule,
    UserTimeSettingsModule,
    SpacesModule,
    SpaceOverviewModule,
    CustomFieldsModule,
    HierarchyConfigModule,
    TaskHierarchyConfigModule,
    TaskTypeFormAssignmentsModule,
    TaskStatusesModule,
    StatusCategoriesModule,
    ResolutionsModule,
    WorkflowEngineModule,
    WorkflowsModule,
    WorkflowTransitionsModule,
    WorkflowAssignmentsModule,
    WorkflowOutboxModule,
    WorkflowCronModule,
    WorkflowTriggersModule,
    GitTriggersModule,
    WorkflowGithubModule,
    GitIntegrationsModule,
    CiServersModule,
    TaskPrioritiesModule,
    RelationTypesModule,
    TasksModule,
    ProcessesModule,
    BoardsModule,
    ListsModule,
    DashboardsModule,
    WikiModule,
    ChatModule,
    ChatAgentModule,
    AuditLogsModule,
    GdprModule,
    NotificationsModule,
    HeatmapModule,
    RiskConfigurationModule,
    CalculationsModule,
    UserGroupsModule,
    CustomRolesModule,
    SpaceOverridesModule,
    SpaceTypesModule,
    SavedFiltersModule,
    FilterExportsModule,
    AssetsModule,
    SprintsModule,
    BoardPermissionsModule,
    // Board sub-features. These were never imported, so their controllers were
    // never registered with Nest and their routes did not exist: every
    // boards-api.service.ts call to /boards/:id/{swimlanes,card-fields,
    // quick-filters,user-state/quick-filters} 404'd in production. Their specs
    // passed throughout because they construct the controllers directly and
    // never exercise this graph. See app-module-coverage.spec.ts, which now
    // fails if a controller is unreachable from here.
    SwimlanesModule,
    CardFieldsModule,
    QuickFiltersModule,
    AiConfigModule,
    PlansModule,
    OrganizationModulesModule,
    McpSettingsModule,
    OrganizationAuthProvidersModule,
    LicensingModule,
    PortfoliosModule,
    // Partner Portal: the /partner workspace + the super-admin /admin/partners
    // provisioning endpoints. Org-scoped; a partner is an organization with
    // organizations.is_partner = true (no new principal type).
    PartnerModule,
    PortfolioSavedViewsModule,
    TimeEntriesModule,
    ActiveTimersModule,
    UploadsModule,
    AttachmentsModule,
    FunnelsModule,
    PagesModule,
    ContactsModule,
    FormFieldsModule,
    DomainsModule,
    MediaModule,
    SubmitModule,
    PublicSiteStudioModule,
    SiteTemplatesModule,
    PublicFormModule,

    // Standalone published forms at /forms/{slug} — the public entry point that
    // does not require a Site Studio funnel to wrap the form.
    PublicFormBuilderModule,
    StripePaymentsModule,
    FormBuilderModule,
    AutomationsModule,
    WhiteboardsModule,
    TestManagementModule,
    InboundEmailModule,
    // Registers the AI automation actions (ai.invoice.extract).
    AiAutomationModule,
    ResourcePlanningModule,
    ResourceScheduleSavedViewsModule,
    AssetsObjectsModule,
    FileExplorerModule,
    HelpCenterModule,
    StorageConfigModule,
    TaskSidebarPreferencesModule,
    SpaceTemplatesModule,
    DocumentDesignerModule,
    CalendarModule,
    // On-prem versioning manifest endpoint. Isolated + additive; served by SaaS too
    // (the SaaS hosts the "latest release" that on-prem clients fetch). No existing
    // route/table/behavior is affected.
    OnpremReleasesModule,
    // Single-tenant helpers. Imported in BOTH builds on purpose: it registers no
    // controllers and OnPremiseTenantService short-circuits on onPrem.enabled, so
    // the auth wiring stays identical in cloud and on-prem.
    OnPremiseModule,
    // On-prem ONLY: in-product System Updates, Licence and Server configuration. Spread
    // is empty in SaaS, so these modules (and all their routes/services) are never registered.
    ...(IS_ON_PREMISE
      ? [OnPremUpdatesModule, OnPremLicenseModule, OnPremConfigModule]
      : []),
    // System Overview (host CPU/RAM/disk) — imported in BOTH builds by product decision:
    // every tenant admin/owner can see this server's own resource usage. Gated by
    // RolesGuard + @RequireRoles('owner', 'admin') on the controller, not by deployment mode.
    SystemMetricsModule,
    SpaceTemplatesModule,
    // Atlassian → XISUITE Migration tool (Tenant Config ▸ Migration). Additive; gated by
    // the `can_manage_migrations` permission + a per-request `organization_modules` toggle.
    MigrationModule,
    // Tenant-wide backups to a customer-owned target. Gated by the module_backup licence key, the
    // backup permission keys, and a per-request organization_modules toggle.
    BackupModule,
    // SAML single sign-on + SCIM provisioning for Microsoft Entra ID (XE-T346).
    SsoModule,
  ],
  controllers: [AppController],
  providers: [
    {
      // Per-user throttling for authenticated traffic, per-IP for anonymous.
      // Replaces the stock ThrottlerGuard, which buckets purely by req.ip and
      // collapses all users behind a reverse proxy into one shared limit.
      provide: APP_GUARD,
      useClass: UserAwareThrottlerGuard,
    },
    // The impersonation Blocked/ReadOnly APP_GUARDs are registered in AuthModule
    // (after SupabaseAuthGuard), not here, so `request.user` is guaranteed
    // populated before they run without relying on cross-module APP_GUARD
    // ordering. See AuthModule providers.
    // Establishes the request-scoped impersonation audit context (ALS) around
    // every handler so audit writes automatically capture the impersonating
    // SA's real user id. Runs after guards (request.user is populated). An
    // ActiveOrgCookieInterceptor APP_INTERCEPTOR also exists in AuthModule —
    // multiple APP_INTERCEPTOR providers are supported and both run.
    {
      provide: APP_INTERCEPTOR,
      useClass: ImpersonationContextInterceptor,
    },
  ],
})
export class AppModule {}
