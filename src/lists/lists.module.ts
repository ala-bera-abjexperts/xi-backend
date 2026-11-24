/**
 * @fileoverview NestJS module for list schemas and items.
 * @module src/lists/lists.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { ListsService } from './lists.service';
import { ListsController } from './lists.controller';
import { ListsSpacesCompatController } from './lists-spaces-compat.controller';

@Module({
  imports: [AutomationsModule, PermissionsModule, UsersModule],
  controllers: [ListsController, ListsSpacesCompatController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
