import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { CustomRolesService } from './custom-roles.service';
import {
  CustomRolesController,
  UserRoleAssignmentsController,
} from './custom-roles.controller';

@Module({
  imports: [PermissionsModule, UsersModule],
  controllers: [CustomRolesController, UserRoleAssignmentsController],
  providers: [CustomRolesService],
  exports: [CustomRolesService],
})
export class CustomRolesModule {}
