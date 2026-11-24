import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';

@Module({
  imports: [PermissionsModule],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripePaymentsModule {}
