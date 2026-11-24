/**
 * @fileoverview Backup & Restore module.
 * @module src/backup/backup.module
 *
 * PermissionsModule supplies PermissionsGuard/PermissionsService, AuditLogsModule the audit writer,
 * and OrganizationModulesModule the per-request module toggle. SupabaseAdminService comes from the
 * global SupabaseModule, so it is not imported here.
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { BackupArchivesController } from './controllers/backup-archives.controller';
import { BackupComponentsController } from './controllers/backup-components.controller';
import { BackupRunsController } from './controllers/backup-runs.controller';
import { BackupSchemesController } from './controllers/backup-schemes.controller';
import { BackupTargetsController } from './controllers/backup-targets.controller';
import { SftpTargetAdapter } from './adapters/sftp/sftp.adapter';
import { BackupCron } from './engine/backup.cron';
import { ArchiveReaderService } from './engine/archive-reader.service';
import { RestoreArchiveCacheService } from './engine/restore-archive-cache.service';
import { BackupSpoolService } from './engine/backup-spool.service';
import { RestorePreflightService } from './engine/restore-preflight.service';
import { RestoreTableWriterService } from './engine/restore-table-writer.service';
import { BackupRestoreController } from './controllers/backup-restore.controller';
import { BackupRestoreService } from './services/backup-restore.service';
import { RestoreDestinationsController } from './controllers/restore-destinations.controller';
import { RestoreDestinationsService } from './services/restore-destinations.service';
import { RestoreEntityMapService } from './services/restore-entity-map.service';
import { RestoreApprovalsController } from './controllers/restore-approvals.controller';
import { RestoreApprovalsService } from './services/restore-approvals.service';
import { BackupStorageService } from './engine/backup-storage.service';
import { BackupQueueService } from './engine/backup-queue.service';
import { BackupReaperService } from './engine/backup-reaper.service';
import { BackupTickService } from './engine/backup-tick.service';
import { BackupWorkerService } from './engine/backup-worker.service';
import { TableExporterService } from './engine/table-exporter.service';
import { BackupArchiveCipherService } from './services/backup-archive-cipher.service';
import { BackupArchivesService } from './services/backup-archives.service';
import { BackupRunsService } from './services/backup-runs.service';
import { BackupScheduleService } from './services/backup-schedule.service';
import { BackupSchemesService } from './services/backup-schemes.service';
import { BackupSecretsService } from './services/backup-secrets.service';
import { BackupTargetsService } from './services/backup-targets.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule, OrganizationModulesModule],
  controllers: [
    BackupTargetsController,
    // Before BackupTargetsController would shadow it: this one owns the nested
    // /backup/targets/:targetId/archives path.
    BackupArchivesController,
    // Before BackupSchemesController: neither declares a conflicting prefix today, but keeping the
    // more specific controller first matches how the automations module orders its routes.
    BackupRunsController,
    BackupSchemesController,
    BackupComponentsController,
    // Before BackupRestoreController: it owns /backup/restore, and a bare `:id` route there would
    // otherwise capture /backup/restore-approvals as a run id.
    RestoreApprovalsController,
    BackupRestoreController,
    RestoreDestinationsController,
  ],
  providers: [
    BackupTargetsService,
    BackupArchivesService,
    BackupSchemesService,
    BackupSecretsService,
    BackupScheduleService,
    BackupRunsService,
    SftpTargetAdapter,
    // The scheduler. ScheduleModule.forRoot() is NOT imported here — it is registered once in
    // app.module.ts and discovers @Cron providers app-wide.
    BackupQueueService,
    BackupTickService,
    BackupReaperService,
    // The executor. Its absence is what left every run at "0 of 172 steps".
    TableExporterService,
    // Stages the human-readable export layer on disk. Required because archiver reads one member
    // at a time, so writing two concurrently deadlocks.
    BackupSpoolService,
    // Copies stored objects into the archive. The path list comes from the version tables, so
    // a bucket is never listed and tenant isolation never rests on a path convention.
    BackupStorageService,
    // Seals the archive before it leaves the process. Without it a scheme with
    // encrypt_archive: true still shipped the whole tenant to SFTP in the clear.
    BackupArchiveCipherService,
    // Opens an archive back up. Until this existed the module could only write, which made every
    // guarantee a backup makes unfalsifiable.
    ArchiveReaderService,
    RestoreArchiveCacheService,
    RestorePreflightService,
    RestoreTableWriterService,
    BackupRestoreService,
    // Where a restore may write. Holds the rule that another organization needs another instance.
    RestoreDestinationsService,
    RestoreEntityMapService,
    // Consent from the organization being written into. Without it a cross-organization restore is
    // refused, which is what stops one tenant deciding alone to put rows in another's.
    RestoreApprovalsService,
    BackupWorkerService,
    BackupCron,
  ],
  exports: [
    BackupTargetsService,
    BackupSchemesService,
    BackupSecretsService,
    BackupScheduleService,
    BackupRunsService,
  ],
})
export class BackupModule {}
