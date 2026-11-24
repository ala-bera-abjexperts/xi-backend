/** @module src/file-explorer/file-explorer-storage-repair.worker.module */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { SupabaseModule } from '../supabase/supabase.module';
import { FileExplorerStorageRepairService } from './file-explorer-storage-repair.service';
import { FileExplorerStorageService } from './file-explorer-storage.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    SupabaseModule,
  ],
  providers: [FileExplorerStorageService, FileExplorerStorageRepairService],
})
export class FileExplorerStorageRepairWorkerModule {}
