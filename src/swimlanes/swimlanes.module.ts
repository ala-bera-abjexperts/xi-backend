import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { SwimlanesService } from './swimlanes.service';
import { SwimlanesController } from './swimlanes.controller';

@Module({
  imports: [PermissionsModule, UsersModule],
  controllers: [SwimlanesController],
  providers: [SwimlanesService],
  exports: [SwimlanesService],
})
export class SwimlanesModule {}
