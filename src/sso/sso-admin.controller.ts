import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  AddSsoDomainDto,
  CreateScimTokenDto,
  CreateSsoConnectionDto,
  UpdateSsoConnectionDto,
  UpdateSsoDomainDto,
  UpdateSsoSettingsDto,
} from './sso-admin.dto';
import { SsoAdminService } from './sso-admin.service';

/**
 * SSO administration for the caller's active workspace (XE-T346).
 *
 * `can_edit_settings` gates the controller; the service additionally requires
 * the membership role to be owner or admin, so a custom-role holder of
 * `can_edit_settings` is refused. Configuration writes need `feature_sso`.
 * Reads, deletes, token revocation, disabling a connection and switching
 * Require SSO off stay open when the licence lapses (read-only grace); other
 * connection updates and switching Require SSO on are checked in the service.
 */
@ApiTags('SSO Administration')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@RequirePermissions('can_edit_settings')
@Controller('organizations/sso')
export class SsoAdminController {
  constructor(private readonly service: SsoAdminService) {}

  @Get('connections')
  @ApiOperation({ summary: 'List SAML connections' })
  listConnections(@CurrentUser() user: RequestUser) {
    return this.service.listConnections(user);
  }

  @Post('connections')
  @RequireFeature('feature_sso')
  @ApiOperation({ summary: 'Create a SAML connection' })
  createConnection(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSsoConnectionDto,
  ) {
    return this.service.createConnection(user, dto);
  }

  // No @RequireFeature: disabling stays allowed unlicensed; the service gates the rest.
  @Patch('connections/:id')
  @ApiOperation({ summary: 'Update a SAML connection' })
  updateConnection(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSsoConnectionDto,
  ) {
    return this.service.updateConnection(user, id, dto);
  }

  @Delete('connections/:id')
  @ApiOperation({ summary: 'Delete a SAML connection' })
  deleteConnection(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteConnection(user, id);
  }

  @Get('domains')
  @ApiOperation({ summary: 'List SSO email domains' })
  listDomains(@CurrentUser() user: RequestUser) {
    return this.service.listDomains(user);
  }

  @Post('domains')
  @RequireFeature('feature_sso')
  @ApiOperation({ summary: 'Add an SSO email domain' })
  addDomain(@CurrentUser() user: RequestUser, @Body() dto: AddSsoDomainDto) {
    return this.service.addDomain(user, dto);
  }

  @Patch('domains/:id')
  @RequireFeature('feature_sso')
  @ApiOperation({ summary: 'Bind or unbind a domain to a connection' })
  updateDomain(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSsoDomainDto,
  ) {
    return this.service.updateDomain(user, id, dto);
  }

  @Post('domains/:id/verify')
  @RequireFeature('feature_sso')
  @ApiOperation({
    summary: 'Verify domain ownership through its DNS TXT record',
  })
  verifyDomain(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.verifyDomain(user, id);
  }

  @Delete('domains/:id')
  @ApiOperation({ summary: 'Remove an SSO email domain' })
  deleteDomain(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteDomain(user, id);
  }

  @Get('scim-tokens')
  @ApiOperation({ summary: 'List SCIM tokens' })
  listScimTokens(@CurrentUser() user: RequestUser) {
    return this.service.listScimTokens(user);
  }

  @Post('scim-tokens')
  @RequireFeature('feature_sso')
  @ApiOperation({ summary: 'Create a SCIM token (plaintext returned once)' })
  createScimToken(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateScimTokenDto,
  ) {
    return this.service.createScimToken(user, dto);
  }

  @Delete('scim-tokens/:id')
  @ApiOperation({ summary: 'Revoke a SCIM token' })
  revokeScimToken(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revokeScimToken(user, id);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get Require SSO and the SCIM base URL' })
  getSettings(@CurrentUser() user: RequestUser) {
    return this.service.getSettings(user);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Switch Require SSO on or off' })
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateSsoSettingsDto,
  ) {
    return this.service.updateSettings(user, dto);
  }
}
