import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { UpdateOrganizationModuleDto } from './dto/update-organization-module.dto';
import { MODULE_TYPE_TO_FEATURE_KEY } from './module-feature-map';
import { OrganizationModulesService } from './organization-modules.service';

@ApiTags('Organization Modules')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('organization-modules')
export class OrganizationModulesController {
  constructor(private readonly service: OrganizationModulesService) {}

  @Get()
  @ApiOperation({ summary: 'List organization-level module toggles' })
  @ApiResponse({ status: 200, description: 'Organization module toggle rows.' })
  list(@CurrentUser() user: RequestUser) {
    return this.service.listForOrg(user.organizationId);
  }

  /**
   * Which licence feature gates each module (module type → catalog key). The
   * settings screen used to hardcode its own copy that called most modules
   * "no licence needed" while this backend gated them, so the switches 403'd
   * with no explanation. One source: this map.
   */
  @Get('feature-map')
  @ApiOperation({ summary: 'Licence feature key that gates each module' })
  featureMap(): Record<string, string> {
    return { ...MODULE_TYPE_TO_FEATURE_KEY } as Record<string, string>;
  }

  @Patch(':moduleType')
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Enable or disable an organization-level module' })
  @ApiParam({ name: 'moduleType', example: 'portfolio', enum: ['portfolio'] })
  @ApiBody({
    type: UpdateOrganizationModuleDto,
    examples: {
      enablePortfolio: { value: { is_enabled: true } },
      disablePortfolio: { value: { is_enabled: false } },
    },
  })
  @ApiResponse({ status: 200, description: 'Module toggle updated.' })
  @ApiResponse({
    status: 400,
    description: 'Unknown module type or invalid payload.',
  })
  @ApiResponse({
    status: 403,
    description: 'Only organization admins or owners can update modules.',
  })
  setEnabled(
    @CurrentUser() user: RequestUser,
    @Param('moduleType') moduleType: string,
    @Body() dto: UpdateOrganizationModuleDto,
  ) {
    return this.service.setEnabled(
      user.organizationId,
      moduleType,
      dto.is_enabled,
      user.userId,
    );
  }
}
