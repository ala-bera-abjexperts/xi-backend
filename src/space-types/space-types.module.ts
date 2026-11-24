import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SpaceTypesService } from './space-types.service';
import { SpaceTypesController } from './space-types.controller';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [SpaceTypesController],
  providers: [SpaceTypesService],
  exports: [SpaceTypesService],
})
export class SpaceTypesModule {}
