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
import { UpdateOrganizationAuthProviderDto } from './dto/update-organization-auth-provider.dto';
import {
  ALLOWED_AUTH_PROVIDERS,
  OrganizationAuthProvidersService,
} from './organization-auth-providers.service';

/**
 * Per-org external-SSO provider toggles (Azure / Keycloak).
 *
 * These endpoints back the on-premise-only "Authentication" tab in Tenant
 * Config. Writes are additionally rejected off-premise inside the service, so
 * the SaaS build can never persist a provider even via a crafted request.
 * The public login page reads the *enabled* set via `GET /auth/oauth/providers`.
 */
@ApiTags('Organization Auth Providers')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('organization-auth-providers')
export class OrganizationAuthProvidersController {
  constructor(private readonly service: OrganizationAuthProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'List organization-level auth-provider toggles' })
  @ApiResponse({ status: 200, description: 'Auth-provider toggle rows.' })
  list(@CurrentUser() user: RequestUser) {
    return this.service.listForOrg(user.organizationId);
  }

  @Patch(':provider')
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Enable or disable an org-level auth provider' })
  @ApiParam({
    name: 'provider',
    example: 'keycloak',
    enum: ALLOWED_AUTH_PROVIDERS,
  })
  @ApiBody({
    type: UpdateOrganizationAuthProviderDto,
    examples: {
      enableKeycloak: { value: { is_enabled: true } },
      disableKeycloak: { value: { is_enabled: false } },
    },
  })
  @ApiResponse({ status: 200, description: 'Auth-provider toggle updated.' })
  @ApiResponse({
    status: 400,
    description: 'Unknown provider or invalid payload.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Not available off-premise, or caller is not an org admin/owner.',
  })
  setEnabled(
    @CurrentUser() user: RequestUser,
    @Param('provider') provider: string,
    @Body() dto: UpdateOrganizationAuthProviderDto,
  ) {
    return this.service.setEnabled(
      user.organizationId,
      provider,
      dto.is_enabled,
      user.userId,
    );
  }
}
