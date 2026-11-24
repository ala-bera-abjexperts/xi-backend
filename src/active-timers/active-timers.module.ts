import { Module } from '@nestjs/common';
import { ActiveTimersController } from './active-timers.controller';
import { ActiveTimersService } from './active-timers.service';
import { TimeEntriesModule } from '../time-entries/time-entries.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [TimeEntriesModule, AuditLogsModule],
  controllers: [ActiveTimersController],
  providers: [ActiveTimersService],
  exports: [ActiveTimersService],
})
export class ActiveTimersModule {}
