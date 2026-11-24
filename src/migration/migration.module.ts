/**
 * @fileoverview NestJS module for the Atlassian → XISUITE Migration tool
 * (Tenant Config ▸ Migration). Phase 0 wires source connections (encrypted creds +
 * connectivity testing); Phase 1 adds source discovery (project listing + preview)
 * and migration jobs (saved wizard output); Phase 2 adds the leased run engine
 * (queue + worker + tick + cron driver + runs lifecycle/SSE) with a no-op probe
 * stage — real stage handlers land in P3+ and register with the StageRegistry.
 *
 * Gating: `PermissionsModule` supplies `PermissionsGuard`/`PermissionsService` for
 * `can_manage_migrations`; `OrganizationModulesModule` supplies the per-request
 * `isEnabled(org, 'migration')` toggle check; `AuditLogsModule` records credential changes.
 * `SupabaseAdminService` is available globally (see `@Global() SupabaseModule`).
 *
 * @module src/migration/migration.module
 */

import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { BoardsModule } from '../boards/boards.module';
// Owns BOTH CustomFieldsService and FieldGroupsService — there is no separate FieldGroupsModule.
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { DocumentDesignerModule } from '../document-designer/document-designer.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SpacesModule } from '../spaces/spaces.module';
import { RelationTypesModule } from '../relation-types/relation-types.module';
import { ResolutionsModule } from '../resolutions/resolutions.module';
import { MailModule } from '../mail/mail.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { UserGroupsModule } from '../user-groups/user-groups.module';
import { SprintsModule } from '../sprints/sprints.module';
import { StatusCategoriesModule } from '../status-categories/status-categories.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { TaskPrioritiesModule } from '../task-priorities/task-priorities.module';
import { TaskStatusesModule } from '../task-statuses/task-statuses.module';
import { TasksModule } from '../tasks/tasks.module';
import { WikiModule } from '../wiki/wiki.module';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { MigrationConnectionsController } from './controllers/migration-connections.controller';
import { MigrationDiscoveryController } from './controllers/migration-discovery.controller';
import { MigrationJobsController } from './controllers/migration-jobs.controller';
import { MigrationRunsController } from './controllers/migration-runs.controller';
import { MigrationConnectionsService } from './services/migration-connections.service';
import { MigrationDiscoveryService } from './services/migration-discovery.service';
import { MigrationEntityMapService } from './services/migration-entity-map.service';
import { MigrationJobsService } from './services/migration-jobs.service';
import { MigrationReportService } from './services/migration-report.service';
import { MigrationRunsService } from './services/migration-runs.service';
import { LegacyWordPreviewService } from './services/legacy-word-preview.service';
import { SourceAdapterFactory } from './adapters/source-adapter.factory';
import { MigrationCronService } from './engine/migration-cron.service';
import { JiraAttachmentRelinkHealService } from './engine/jira-attachment-relink-heal.service';
import { MigrationQueueService } from './engine/migration-queue.service';
import { MigrationTickService } from './engine/migration-tick.service';
import { MigrationWorkerService } from './engine/migration-worker.service';
import { AttachmentsStage } from './engine/stages/attachments.stage';
import { JiraAttachmentRelinkStage } from './engine/stages/jira-attachment-relink.stage';
import { ConfluencePageHierarchyStage } from './engine/stages/confluence-page-hierarchy.stage';
import { ConfluencePageRepairStage } from './engine/stages/confluence-page-repair.stage';
import { HistoryStage } from './engine/stages/history.stage';
import { BoardCardsStage } from './engine/stages/board-cards.stage';
import { BoardsStage } from './engine/stages/boards.stage';
import { CommentsStage } from './engine/stages/comments.stage';
import { CustomFieldsStage } from './engine/stages/custom-fields.stage';
import { FieldGroupsStage } from './engine/stages/field-groups.stage';
import { IssuesStage } from './engine/stages/issues.stage';
import { WatchersStage } from './engine/stages/watchers.stage';
import { IssueTypeStage } from './engine/stages/issue-type.stage';
import { LinksStage } from './engine/stages/links.stage';
import { NoopProbeStage } from './engine/stages/noop.stage';
import { PriorityStage } from './engine/stages/priority.stage';
import { ResolutionsStage } from './engine/stages/resolutions.stage';
import { RolesStage } from './engine/stages/roles.stage';
import { SpaceStage } from './engine/stages/space.stage';
import { SprintsStage } from './engine/stages/sprints.stage';
import { StageRegistry } from './engine/stages/stage.registry';
import { StatusCategoryStage } from './engine/stages/status-category.stage';
import { TaskStatusStage } from './engine/stages/task-status.stage';
import { GroupsStage } from './engine/stages/groups.stage';
import { UsersStage } from './engine/stages/users.stage';
import { VerifyStage } from './engine/stages/verify.stage';
import { WorkflowAssignmentsStage } from './engine/stages/workflow-assignments.stage';
import { WorkflowsStage } from './engine/stages/workflows.stage';
import { ConfluenceSpaceStage } from './engine/stages/confluence-space.stage';
import { PagesStage } from './engine/stages/pages.stage';
import { PageAttachmentsStage } from './engine/stages/page-attachments.stage';
import { PageCommentsStage } from './engine/stages/page-comments.stage';
import { PageLabelsStage } from './engine/stages/page-labels.stage';
import { PageRestrictionsStage } from './engine/stages/page-restrictions.stage';
import { PageRelinkStage } from './engine/stages/page-relink.stage';
import { PageMapper } from './mappers/page.mapper';
import { UserMapper } from './mappers/user.mapper';
import { ContentTransformService } from './transformers/content-transform.service';
import { PageHistoryStage } from './engine/stages/page-history.stage';
import { ConfluenceWatchersStage } from './engine/stages/confluence-watchers.stage';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [
    PermissionsModule,
    AuditLogsModule,
    OrganizationModulesModule,
    DocumentDesignerModule,
    SpacesModule,
    StatusCategoriesModule,
    TaskStatusesModule,
    TaskPrioritiesModule,
    TaskHierarchyConfigModule,
    WikiModule,
    // PageHistoryStage writes versioned attachment binaries through AttachmentsService.
    AttachmentsModule,
    CustomFieldsModule,
    WorkflowsModule,
    WorkflowAssignmentsModule,
    TasksModule,
    BoardsModule,
    SprintsModule,
    // `links` creates a relation type when a Jira link type has no XISUITE counterpart, instead of
    // silently relabelling the edge as a generic "Relates".
    RelationTypesModule,
    // `resolutions` adopts the org's seeded resolutions (or creates new ones) so issues can carry
    // resolution_id, and the issues stage resolves through its crosswalk.
    ResolutionsModule,
    // `groups` migrates Jira groups org-level so `roles` can grant space access to the GROUP
    // (member_type='group') instead of flattening its membership away.
    UserGroupsModule,
    // `users` mails a set-password link when a job opts into provisioning real accounts.
    MailModule,
    // `users` invites unmatched source users when a job opts into invites (XE-T682).
    InvitationsModule,
  ],
  controllers: [
    MigrationConnectionsController,
    MigrationDiscoveryController,
    MigrationJobsController,
    MigrationRunsController,
  ],
  providers: [
    MigrationConnectionsService,
    MigrationDiscoveryService,
    MigrationJobsService,
    MigrationEntityMapService,
    MigrationRunsService,
    LegacyWordPreviewService,
    MigrationReportService,
    SourceAdapterFactory,
    StageRegistry,
    NoopProbeStage,
    UserMapper,
    UsersStage,
    GroupsStage,
    SpaceStage,
    RolesStage,
    StatusCategoryStage,
    TaskStatusStage,
    PriorityStage,
    ResolutionsStage,
    IssueTypeStage,
    CustomFieldsStage,
    FieldGroupsStage,
    WorkflowsStage,
    WorkflowAssignmentsStage,
    IssuesStage,
    WatchersStage,
    BoardsStage,
    BoardCardsStage,
    SprintsStage,
    LinksStage,
    CommentsStage,
    AttachmentsStage,
    JiraAttachmentRelinkStage,
    HistoryStage,
    VerifyStage,
    ContentTransformService,
    PageMapper,
    ConfluenceSpaceStage,
    PagesStage,
    ConfluenceWatchersStage,
    PageAttachmentsStage,
    PageCommentsStage,
    PageLabelsStage,
    PageRestrictionsStage,
    PageRelinkStage,
    PageHistoryStage,
    ConfluencePageHierarchyStage,
    ConfluencePageRepairStage,
    MigrationQueueService,
    MigrationWorkerService,
    MigrationTickService,
    MigrationCronService,
    JiraAttachmentRelinkHealService,
  ],
  exports: [
    MigrationConnectionsService,
    MigrationDiscoveryService,
    MigrationJobsService,
    MigrationEntityMapService,
    MigrationRunsService,
    MigrationReportService,
    SourceAdapterFactory,
    StageRegistry,
    MigrationQueueService,
  ],
})
export class MigrationModule implements OnModuleInit {
  constructor(
    private readonly registry: StageRegistry,
    private readonly noopProbe: NoopProbeStage,
    private readonly usersStage: UsersStage,
    private readonly groupsStage: GroupsStage,
    private readonly spaceStage: SpaceStage,
    private readonly rolesStage: RolesStage,
    private readonly statusCategoryStage: StatusCategoryStage,
    private readonly taskStatusStage: TaskStatusStage,
    private readonly priorityStage: PriorityStage,
    private readonly resolutionsStage: ResolutionsStage,
    private readonly issueTypeStage: IssueTypeStage,
    private readonly customFieldsStage: CustomFieldsStage,
    private readonly fieldGroupsStage: FieldGroupsStage,
    private readonly workflowsStage: WorkflowsStage,
    private readonly workflowAssignmentsStage: WorkflowAssignmentsStage,
    private readonly issuesStage: IssuesStage,
    private readonly watchersStage: WatchersStage,
    private readonly boardsStage: BoardsStage,
    private readonly boardCardsStage: BoardCardsStage,
    private readonly sprintsStage: SprintsStage,
    private readonly linksStage: LinksStage,
    private readonly commentsStage: CommentsStage,
    private readonly attachmentsStage: AttachmentsStage,
    private readonly jiraAttachmentRelinkStage: JiraAttachmentRelinkStage,
    private readonly historyStage: HistoryStage,
    private readonly verifyStage: VerifyStage,
    private readonly confluenceSpaceStage: ConfluenceSpaceStage,
    private readonly pagesStage: PagesStage,
    private readonly confluenceWatchersStage: ConfluenceWatchersStage,
    private readonly pageAttachmentsStage: PageAttachmentsStage,
    private readonly pageLabelsStage: PageLabelsStage,
    private readonly pageCommentsStage: PageCommentsStage,
    private readonly pageRestrictionsStage: PageRestrictionsStage,
    private readonly pageRelinkStage: PageRelinkStage,
    private readonly pageHistoryStage: PageHistoryStage,
    private readonly confluencePageHierarchyStage: ConfluencePageHierarchyStage,
    private readonly confluencePageRepairStage: ConfluencePageRepairStage,
  ) {}

  /**
   * Stage handlers register here; P5+ handlers append their own registrations.
   * The probe stays registered as the fallback plan for harness runs — once a
   * real canonical stage is registered, `planFor` never selects the probe.
   */
  onModuleInit(): void {
    this.registry.register(this.noopProbe);
    this.registry.register(this.usersStage);
    this.registry.register(this.groupsStage);
    this.registry.register(this.spaceStage);
    this.registry.register(this.rolesStage);
    this.registry.register(this.statusCategoryStage);
    this.registry.register(this.taskStatusStage);
    this.registry.register(this.priorityStage);
    this.registry.register(this.resolutionsStage);
    this.registry.register(this.issueTypeStage);
    this.registry.register(this.customFieldsStage);
    this.registry.register(this.fieldGroupsStage);
    // `workflows` MUST stay ahead of `workflow_assignments`: an assignment flips the
    // trigger-managed `workflows.is_active`, after which saveCanvas 409s on the now-active workflow.
    this.registry.register(this.workflowsStage);
    this.registry.register(this.workflowAssignmentsStage);
    this.registry.register(this.issuesStage);
    this.registry.register(this.watchersStage);
    this.registry.register(this.boardsStage);
    this.registry.register(this.boardCardsStage);
    this.registry.register(this.sprintsStage);
    this.registry.register(this.linksStage);
    this.registry.register(this.commentsStage);
    this.registry.register(this.attachmentsStage);
    this.registry.register(this.jiraAttachmentRelinkStage);
    this.registry.register(this.historyStage);
    this.registry.register(this.confluenceSpaceStage);
    this.registry.register(this.pagesStage);
    this.registry.register(this.confluenceWatchersStage);
    this.registry.register(this.pageAttachmentsStage);
    this.registry.register(this.confluencePageHierarchyStage);
    this.registry.register(this.confluencePageRepairStage);
    this.registry.register(this.pageRelinkStage);
    this.registry.register(this.pageHistoryStage);
    this.registry.register(this.pageLabelsStage);
    this.registry.register(this.pageCommentsStage);
    this.registry.register(this.pageRestrictionsStage);
    // Terminal node of BOTH canonical orders — reconciles source counts against the crosswalk.
    this.registry.register(this.verifyStage);
  }
}
