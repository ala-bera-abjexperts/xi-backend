import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  CreateLicenseChangeRequestDto,
  ListChangeRequestsQueryDto,
  ListLicensePlansQueryDto,
  ListUsageCountersQueryDto,
} from './dto/licensing.dto';
import { LicensingService } from './licensing.service';

@ApiTags('Licensing')
@ApiBearerAuth()
@ImpersonationBlocked()
@UseGuards(RolesGuard)
@RequireRoles('owner')
@Controller('licensing')
export class LicensingController {
  constructor(private readonly service: LicensingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List active license plans' })
  listPlans(@Query() query: ListLicensePlansQueryDto) {
    return this.service.listPlans(query, true);
  }

  @Get('current')
  @ApiOperation({ summary: 'Get the current tenant license' })
  getCurrent(@CurrentUser() user: RequestUser) {
    return this.service.getCurrentLicense(user.organizationId);
  }

  @Get('usage')
  @ApiOperation({ summary: 'List current tenant license usage counters' })
  listUsage(
    @CurrentUser() user: RequestUser,
    @Query() query: ListUsageCountersQueryDto,
  ) {
    return this.service.listUsage(user.organizationId, query);
  }

  @Get('change-requests')
  @ApiOperation({ summary: 'List current tenant license change requests' })
  listChangeRequests(
    @CurrentUser() user: RequestUser,
    @Query() query: ListChangeRequestsQueryDto,
  ) {
    return this.service.listTenantChangeRequests(user.organizationId, query);
  }

  @Post('change-requests')
  @ApiOperation({ summary: 'Create a license change request' })
  createChangeRequest(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateLicenseChangeRequestDto,
  ) {
    return this.service.createTenantChangeRequest(
      user.organizationId,
      dto,
      user,
    );
  }

  @Patch('change-requests/:requestId/cancel')
  @ApiOperation({ summary: 'Cancel a pending license change request' })
  cancelChangeRequest(
    @CurrentUser() user: RequestUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.service.cancelTenantChangeRequest(
      user.organizationId,
      requestId,
      user,
    );
  }
}
