import { SlaModule } from '../sla/sla.module';
import { Module } from '@nestjs/common';
import { HelpCenterController } from './help-center.controller';
import { HelpCenterSpacesController } from './help-center-spaces.controller';
import { HelpCenterService } from './help-center.service';
import { HelpCenterRepository } from './help-center.repository';
import { TasksModule } from '../tasks/tasks.module';

import { LicensingModule } from '../licensing/licensing.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';

@Module({
  imports: [TasksModule, LicensingModule, SlaModule, WorkflowEngineModule],
  controllers: [HelpCenterController, HelpCenterSpacesController],
  providers: [HelpCenterService, HelpCenterRepository],
  exports: [HelpCenterService],
})
export class HelpCenterModule {}
