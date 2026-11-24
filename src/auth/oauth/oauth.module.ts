/**
 * @fileoverview NestJS module wiring the OAuth controller + service.
 * @module src/auth/oauth/oauth.module
 */

import { Module } from '@nestjs/common';
import { OrganizationAuthProvidersModule } from '../../organization-auth-providers/organization-auth-providers.module';
import { UsersModule } from '../../users/users.module';
import { AuthModule } from '../auth.module';
import { OauthController } from './oauth.controller';
import { OauthService } from './oauth.service';

@Module({
  imports: [OrganizationAuthProvidersModule, UsersModule, AuthModule],
  controllers: [OauthController],
  providers: [OauthService],
  exports: [OauthService],
})
export class OauthModule {}
