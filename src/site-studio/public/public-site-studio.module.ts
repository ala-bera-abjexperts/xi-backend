import { Module } from '@nestjs/common';
import { AgentOriginModule } from '../../chat-agent/agent-origin.module';
import { FileExplorerModule } from '../../file-explorer/file-explorer.module';
import { ProcessesModule } from '../../processes/processes.module';
import { TasksModule } from '../../tasks/tasks.module';
import { WikiModule } from '../../wiki/wiki.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PublicSiteStudioController } from './public-site-studio.controller';
import { PublicSiteStudioService } from './public-site-studio.service';

@Module({
  imports: [
    AgentOriginModule,
    TasksModule,
    ProcessesModule,
    WikiModule,
    FileExplorerModule,
    PermissionsModule,
  ],
  controllers: [PublicSiteStudioController],
  providers: [PublicSiteStudioService],
})
export class PublicSiteStudioModule {}
