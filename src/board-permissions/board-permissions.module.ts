import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { BoardPermissionsController } from './board-permissions.controller';
import { BoardPermissionsService } from './board-permissions.service';

@Module({
  imports: [PermissionsModule, UsersModule],
  controllers: [BoardPermissionsController],
  providers: [BoardPermissionsService],
  exports: [BoardPermissionsService],
})
export class BoardPermissionsModule {}
