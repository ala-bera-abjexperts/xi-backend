import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { FormFieldsController } from './form-fields.controller';
import { FormFieldsService } from './form-fields.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [FormFieldsController],
  providers: [FormFieldsService],
})
export class FormFieldsModule {}
