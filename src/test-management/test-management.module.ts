import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { SsoEnforcementService } from '../auth/sso-enforcement.service';
import { CiServersModule } from '../ci-servers/ci-servers.module';
import { DocumentDesignerModule } from '../document-designer/document-designer.module';
import { GitIntegrationsModule } from '../git-integrations/git-integrations.module';
import { LicensingModule } from '../licensing/licensing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { TasksModule } from '../tasks/tasks.module';
import { TestManagementAccessModule } from './access/test-management-access.module';
import { TestManagementApiKeysController } from './api-keys/test-management-api-keys.controller';
import { TestManagementApiKeysService } from './api-keys/test-management-api-keys.service';
import { TestManagementAuthenticateController } from './api-keys/test-management-authenticate.controller';
import { TestCasesController } from './cases/test-cases.controller';
import { TestCasesService } from './cases/test-cases.service';
import { TaskVisibilityService } from './common/task-visibility.service';
import { TesterEligibilityService } from './common/tester-eligibility.service';
import { TestCoverageController } from './coverage/test-coverage.controller';
import { TestCoverageService } from './coverage/test-coverage.service';
import { TestDefectsController } from './defects/test-defects.controller';
import { TestDefectsService } from './defects/test-defects.service';
import { TestExecutionsController } from './executions/test-executions.controller';
import { TestHistoryController } from './history/test-history.controller';
import { TestHistoryService } from './history/test-history.service';
import { TestExecutionsService } from './executions/test-executions.service';
import { TestFoldersController } from './folders/test-folders.controller';
import { TestFoldersService } from './folders/test-folders.service';
import { TestPlansController } from './plans/test-plans.controller';
import { TestPlanTestsService } from './plans/test-plan-tests.service';
import { TestPlansService } from './plans/test-plans.service';
import { TestPreconditionsController } from './preconditions/test-preconditions.controller';
import { TestPreconditionsService } from './preconditions/test-preconditions.service';
import { TestReportsController } from './reports/test-reports.controller';
import { TestReportsService } from './reports/test-reports.service';
import { TestRequirementLinksController } from './requirements/test-requirement-links.controller';
import { TestRequirementLinksService } from './requirements/test-requirement-links.service';
import { TestResultsController } from './results/test-results.controller';
import { TestResultsService } from './results/test-results.service';
import { TestRunsController } from './runs/test-runs.controller';
import { TestRunEvidenceService } from './runs/test-run-evidence.service';
import { TestRunsService } from './runs/test-runs.service';
import { TestSetsController } from './sets/test-sets.controller';
import { TestSetsService } from './sets/test-sets.service';
import { TestManagementSettingsController } from './settings/test-management-settings.controller';
import { TestManagementTaskTypesController } from './settings/test-management-task-types.controller';
import { TestManagementSettingsService } from './settings/test-management-settings.service';
import { TestManagementSpacesController } from './spaces/test-management-spaces.controller';
import { TestManagementSpacesService } from './spaces/test-management-spaces.service';
import {
  CucumberResultsController,
  ResultsImportController,
} from './transfer/cucumber-results/cucumber-results.controller';
import { CucumberResultsService } from './transfer/cucumber-results/cucumber-results.service';
import { FeatureExportController } from './transfer/feature-export/feature-export.controller';
import { FeatureExportService } from './transfer/feature-export/feature-export.service';
import { FeatureImportController } from './transfer/feature-import/feature-import.controller';
import { FeatureImportService } from './transfer/feature-import/feature-import.service';
import { TestTicketService } from './tickets/test-ticket.service';
import { TestAutomationController } from './automation/test-automation.controller';
import { TestAutomationCiService } from './automation/test-automation-ci.service';
import { TestAutomationCiVariablesService } from './automation/test-automation-ci-variables.service';
import { TestAutomationCiWatcherService } from './automation/test-automation-ci-watcher.service';
import { TestAutomationConfigsService } from './automation/test-automation-configs.service';
import { TestAutomationGitService } from './automation/test-automation-git.service';
import { TestAutomationReaperService } from './automation/test-automation-reaper.service';
import { TestAutomationRunsService } from './automation/test-automation-runs.service';
import { RunnerLauncher } from './automation/runner-launcher';
import { TestAutomationRunnerService } from './automation/test-automation-runner.service';
import { TestRunnerAdminController } from './test-runner/test-runner-admin.controller';
import { TestAutomationCustomImageCleanupService } from './automation/custom-images/cleanup/test-automation-custom-image-cleanup.service';
import { TestAutomationCustomImagesController } from './automation/test-automation-custom-images.controller';
import { TestAutomationCustomImagesService } from './automation/test-automation-custom-images.service';
import { TestAutomationCustomImageUploadsController } from './automation/custom-images/upload/controller/test-automation-custom-image-uploads.controller';
import { TestAutomationCustomImageUploadsService } from './automation/custom-images/upload/service/test-automation-custom-image-uploads.service';
import { CustomImageApprovalController } from './automation/custom-images/approval/controller/custom-image-approval.controller';
import { CustomImageApprovalService } from './automation/custom-images/approval/service/custom-image-approval.service';

@Module({
  // SupabaseModule is @Global(). PermissionsModule backs SpacePermissionsGuard and PermissionsGuard.
  imports: [
    AuditLogsModule,
    OrganizationModulesModule,
    PermissionsModule,
    TestManagementAccessModule,
    // Test task types are added to the space's hierarchy; imports nothing of this module back.
    TaskHierarchyConfigModule,
    // Execution tickets are created through TasksService; imports nothing of this module back.
    TasksModule,
    // PDF export of reports; imports nothing of this module back.
    DocumentDesignerModule,
    // An uploaded results file is kept on its execution.
    AttachmentsModule,
    // GitHub connections and the licence check for CI jobs; neither imports this module back.
    GitIntegrationsModule,
    // Jenkins servers that CI jobs sign in with; imports nothing of this module back.
    CiServersModule,
    LicensingModule,
    // Custom image approval notices; imports nothing of this module back.
    NotificationsModule,
  ],
  controllers: [
    TestManagementSettingsController,
    TestManagementTaskTypesController,
    TestFoldersController,
    TestCasesController,
    TestSetsController,
    TestPlansController,
    TestPreconditionsController,
    TestManagementSpacesController,
    TestExecutionsController,
    TestRunsController,
    TestResultsController,
    TestReportsController,
    TestDefectsController,
    TestHistoryController,
    TestRequirementLinksController,
    TestCoverageController,
    FeatureImportController,
    FeatureExportController,
    CucumberResultsController,
    ResultsImportController,
    TestManagementApiKeysController,
    TestManagementAuthenticateController,
    TestAutomationController,
    TestRunnerAdminController,
    TestAutomationCustomImagesController,
    TestAutomationCustomImageUploadsController,
    CustomImageApprovalController,
  ],
  providers: [
    TestManagementSettingsService,
    TestManagementSpacesService,
    TestCasesService,
    TestFoldersService,
    TestSetsService,
    TestPlansService,
    TestPlanTestsService,
    TestPreconditionsService,
    TesterEligibilityService,
    TestTicketService,
    TestExecutionsService,
    TestRunsService,
    TestRunEvidenceService,
    TestResultsService,
    TestReportsService,
    TaskVisibilityService,
    TestDefectsService,
    TestHistoryService,
    TestRequirementLinksService,
    TestCoverageService,
    FeatureImportService,
    FeatureExportService,
    CucumberResultsService,
    TestManagementApiKeysService,
    // Require SSO check for key creation; AuthModule does not export it.
    SsoEnforcementService,
    TestAutomationGitService,
    TestAutomationConfigsService,
    TestAutomationCiService,
    TestAutomationCiVariablesService,
    TestAutomationCiWatcherService,
    TestAutomationRunsService,
    TestAutomationReaperService,
    TestAutomationRunnerService,
    RunnerLauncher,
    // Only the platform-admin Stop route of the test runner uses it.
    SuperAdminGuard,
    TestAutomationCustomImagesService,
    TestAutomationCustomImageCleanupService,
    TestAutomationCustomImageUploadsService,
    CustomImageApprovalService,
  ],
  // The space module switch keeps the test task types in step.
  exports: [TestManagementSettingsService],
})
export class TestManagementModule {}
