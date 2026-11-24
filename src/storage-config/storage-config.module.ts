import { Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { StorageConfigController } from './storage-config.controller';
import { StorageConfigRepository } from './storage-config.repository';
import { StorageConfigService } from './storage-config.service';

@Module({
  imports: [LicensingModule],
  controllers: [StorageConfigController],
  providers: [StorageConfigService, StorageConfigRepository],
  exports: [StorageConfigService],
})
export class StorageConfigModule {}
