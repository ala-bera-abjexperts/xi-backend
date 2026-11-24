import { forwardRef, Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WikiModule } from '../wiki/wiki.module';
import { WatchersService } from './watchers.service';

@Module({
  imports: [
    PermissionsModule,
    NotificationsModule,
    forwardRef(() => WikiModule),
  ],
  providers: [WatchersService],
  exports: [WatchersService],
})
export class WatchersModule {}
