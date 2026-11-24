import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
