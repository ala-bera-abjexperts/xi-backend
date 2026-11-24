/**
 * @fileoverview Org-level Git integrations (Tenant Configuration > Integrations): GitHub App and
 * GitLab OAuth connections, repository selection, webhooks and health checks.
 *
 * Independent of the legacy workflow-editor PAT feature (WorkflowGithubModule / GitTriggersModule),
 * which keeps working unchanged. `SupabaseAdminService` comes from the global SupabaseModule; this
 * module MUST be registered in `app.module.ts`.
 * @module src/git-integrations/git-integrations.module
 */

import { forwardRef, Module } from '@nestjs/common';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { WatchersModule } from '../watchers/watchers.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { AzureDevopsClient } from './azure-devops/azure-devops.client';
import { AzureDevopsIntegrationService } from './azure-devops/azure-devops-integration.service';
import { GithubAppClient } from './github/github-app.client';
import { GithubIntegrationService } from './github/github-integration.service';
import { GitlabClient } from './gitlab/gitlab.client';
import { GitlabIntegrationService } from './gitlab/gitlab-integration.service';
import { GitActivityService } from './git-activity.service';
import { GitBranchController } from './git-branch.controller';
import { GitIdentitiesController } from './git-identities.controller';
import { GitIdentitiesService } from './git-identities.service';
import { GitIntegrationsHealthCron } from './git-integrations-health.cron';
import { GitIntegrationsPublicController } from './git-integrations-public.controller';
import { GitIntegrationsController } from './git-integrations.controller';
import { GitIntegrationsService } from './git-integrations.service';
import { GitProvidersRegistry } from './git-providers.registry';
import { GitPullRequestsController } from './git-pull-requests.controller';
import { GitPullRequestsService } from './git-pull-requests.service';
import { GitServerTestService } from './git-server-test.service';
import { GitServersService } from './git-servers.service';
import { GitSpaceRepositoriesController } from './git-space-repositories.controller';
import { GitStatusAutomationService } from './git-status-automation.service';

@Module({
  // PermissionsModule: PermissionsGuard on the task pull request routes.
  // WorkflowEngineModule (ticket 8): the engine under WORKFLOW_ENGINE_SERVICE, via forwardRef as GitTriggersModule.
  // WatchersModule (ticket 9): watchers, task visibility and mutes for development notifications.
  imports: [
    AuditLogsModule,
    NotificationsModule,
    PermissionsModule,
    WatchersModule,
    WorkflowAssignmentsModule,
    forwardRef(() => WorkflowEngineModule),
  ],
  controllers: [
    GitIntegrationsController,
    GitIntegrationsPublicController,
    GitIdentitiesController,
    GitBranchController,
    GitPullRequestsController,
    // Development module: the repositories each space shows.
    GitSpaceRepositoriesController,
  ],
  providers: [
    GitIntegrationsService,
    GitIdentitiesService,
    GitPullRequestsService,
    GitStatusAutomationService,
    GitActivityService,
    GithubAppClient,
    GithubIntegrationService,
    GitlabClient,
    GitlabIntegrationService,
    AzureDevopsClient,
    AzureDevopsIntegrationService,
    GitProvidersRegistry,
    GitIntegrationsHealthCron,
    // Ticket 11: organizations' own servers (GitHub Enterprise Server, self-managed GitLab).
    GitServersService,
    GitServerTestService,
  ],
  exports: [GitIntegrationsService, GitIdentitiesService],
})
export class GitIntegrationsModule {}
