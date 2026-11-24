import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AdminTenantsService } from './admin-tenants.service';

@ImpersonationBlocked()
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
export class AdminController {
  constructor(private readonly adminTenantsService: AdminTenantsService) {}

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.adminTenantsService.getSuperAdminProfile(user.userId);
  }
}
