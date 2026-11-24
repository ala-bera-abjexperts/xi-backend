import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { SavedFiltersModule } from '../saved-filters/saved-filters.module';
import { UsersModule } from '../users/users.module';
import { AutomationsModule } from '../automations/automations.module';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { PlansController } from './plans.controller';
import { PlansMineController } from './plans-mine.controller';
import { PlansService } from './plans.service';
import { PlansMineService } from './plans-mine.service';
import { PlansAiService } from './plans-ai.service';

@Module({
  imports: [
    PermissionsModule,
    SavedFiltersModule,
    UsersModule,
    AutomationsModule,
    // XE-T353 1.22: "Drafted by Robert" on the plan detail; depends on nothing of chat.
    AgentOriginModule,
  ],
  // PlansMineController first: its literal `plans/mine/*` routes must never be
  // shadowed by PlansController's `:planId` params as the mine family grows.
  controllers: [PlansMineController, PlansController],
  providers: [PlansService, PlansMineService, PlansAiService],
  exports: [PlansService],
})
export class PlansModule {}
