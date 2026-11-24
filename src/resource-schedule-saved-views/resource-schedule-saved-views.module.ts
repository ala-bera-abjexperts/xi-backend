import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { ResourceScheduleSavedViewRepository } from './resource-schedule-saved-view.repository';
import { ResourceScheduleSavedViewsController } from './resource-schedule-saved-views.controller';
import { ResourceScheduleSavedViewsService } from './resource-schedule-saved-views.service';

@Module({
  imports: [PermissionsModule],
  controllers: [ResourceScheduleSavedViewsController],
  providers: [
    ResourceScheduleSavedViewsService,
    ResourceScheduleSavedViewRepository,
  ],
})
export class ResourceScheduleSavedViewsModule {}
