import { Module } from '@nestjs/common';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { AssetsObjectsModule } from '../assets-objects/assets-objects.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AutomationsModule } from '../automations/automations.module';
import { FileExplorerModule } from '../file-explorer/file-explorer.module';
import { LicensingModule } from '../licensing/licensing.module';
import { MailModule } from '../mail/mail.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SavedFiltersModule } from '../saved-filters/saved-filters.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { WikiModule } from '../wiki/wiki.module';
import { ExportByTemplateAction } from './automation/export-by-template.action';
import { BindableFieldsService } from './bindable-fields.service';
import { DocumentExportRepository } from './document-export.repository';
import { DocumentExportsCleanupService } from './document-exports-cleanup.service';
import { DocumentExportsController } from './document-exports.controller';
import { DocumentExportsService } from './document-exports.service';
import { DocumentTemplateRepository } from './document-template.repository';
import { DocumentTemplateVersionsController } from './document-template-versions.controller';
import { DocumentTemplateVersionsService } from './document-template-versions.service';
import { DocumentTemplatesController } from './document-templates.controller';
import { DocumentTemplatesService } from './document-templates.service';
import { DocumentWikiPushService } from './document-wiki-push.service';
import { DocumentDataResolverService } from './rendering/document-data-resolver.service';
import { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import { DocumentRenderService } from './rendering/document-render.service';
import { DocumentTaskListsService } from './rendering/document-task-lists.service';
import { DocxRenderService } from './rendering/docx-render.service';
import { PdfRenderService } from './rendering/pdf-render.service';
import { TipTapRenderService } from './rendering/tiptap-render.service';

// SupabaseModule is @Global() — SupabaseAdminService needs no import here.
// ScheduleModule.forRoot() is registered in AppModule, so the cleanup
// service's @Cron registers without a local ScheduleModule import.
// AutomationsModule + MailModule power the "Export by Template" automation
// action; WikiModule powers the wiki-push path; FileExplorerModule powers the
// save-as-file destination of that same action — all three point this way
// only (none import DocumentDesignerModule back), so no forwardRef is needed.
@Module({
  imports: [
    AgentOriginModule,
    PermissionsModule,
    AuditLogsModule,
    SavedFiltersModule,
    AutomationsModule,
    MailModule,
    AssetsObjectsModule,
    WikiModule,
    FileExplorerModule,
    // Task lists: licence check for wiki/assets lists, task-type names in history.
    LicensingModule,
    TaskHierarchyConfigModule,
  ],
  controllers: [
    DocumentTemplatesController,
    DocumentTemplateVersionsController,
    DocumentExportsController,
  ],
  providers: [
    DocumentTemplatesService,
    DocumentTemplateVersionsService,
    DocumentTemplateRepository,
    DocumentExportRepository,
    BindableFieldsService,
    DocumentDataResolverService,
    DocumentTaskListsService,
    DocumentImageResolverService,
    DocumentRenderService,
    PdfRenderService,
    DocxRenderService,
    TipTapRenderService,
    DocumentExportsService,
    DocumentExportsCleanupService,
    DocumentWikiPushService,
    ExportByTemplateAction,
  ],
  exports: [
    DocumentTemplatesService,
    DocumentRenderService,
    DocumentDataResolverService,
    DocumentTemplateRepository,
    DocumentExportRepository,
    PdfRenderService,
    // The automation wave consumes exports (attach/send flows).
    DocumentExportsService,
  ],
})
export class DocumentDesignerModule {}
