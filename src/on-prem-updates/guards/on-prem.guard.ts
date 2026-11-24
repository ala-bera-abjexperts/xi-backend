/**
 * @fileoverview Defense-in-depth guard for the On-Prem Updates feature. The module
 * is already only imported when IS_ON_PREMISE is truthy (so its routes don't exist
 * in SaaS), but this guard additionally fail-closes at request time: if the on-prem
 * flag is somehow not set, every route behaves as Not Found.
 * @module src/on-prem-updates/guards/on-prem.guard
 */
import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OnPremGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!this.config.get<boolean>('onPrem.enabled')) {
      // 404 (not 403): the feature does not exist off-prem.
      throw new NotFoundException();
    }
    return true;
  }
}
