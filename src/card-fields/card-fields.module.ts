import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { CardFieldsService } from './card-fields.service';
import { CardFieldsController } from './card-fields.controller';

@Module({
  imports: [PermissionsModule, UsersModule],
  controllers: [CardFieldsController],
  providers: [CardFieldsService],
  exports: [CardFieldsService],
})
export class CardFieldsModule {}
