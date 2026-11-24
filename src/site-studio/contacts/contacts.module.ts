import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
