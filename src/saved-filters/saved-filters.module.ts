import { Module } from '@nestjs/common';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { SavedFiltersService } from './saved-filters.service';
import { SavedFiltersController } from './saved-filters.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { LicensingModule } from '../licensing/licensing.module';

@Module({
  imports: [
    AgentOriginModule,
    PermissionsModule, LicensingModule],
  controllers: [SavedFiltersController],
  providers: [SavedFiltersService],
  exports: [SavedFiltersService],
})
export class SavedFiltersModule {}
