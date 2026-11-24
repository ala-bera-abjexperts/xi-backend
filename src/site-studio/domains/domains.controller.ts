import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { AddDomainDto } from './dto/add-domain.dto';
import { DomainsService } from './domains.service';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Domains')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels/:funnelId/domains')
export class DomainsController {
  constructor(private readonly service: DomainsService) {}

  @Get()
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'List custom domains for a funnel' })
  @ApiParam({ name: 'funnelId' })
  async getDomains(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    const domains = await this.service.getDomains(
      funnelId,
      user.organizationId,
    );
    return { data: domains };
  }

  @Post()
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Add a custom domain to a funnel' })
  @ApiParam({ name: 'funnelId' })
  async addDomain(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: AddDomainDto,
  ) {
    const result = await this.service.addDomain(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: result };
  }

  @Delete(':domainId')
  @RequirePermissions('can_delete_site_studio')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a custom domain' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'domainId' })
  async removeDomain(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    await this.service.removeDomain(
      funnelId,
      domainId,
      user.organizationId,
      user.userId,
    );
  }

  @Post(':domainId/verify')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Verify domain ownership via DNS TXT record' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'domainId' })
  async verifyDomain(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    const domain = await this.service.verifyDomain(
      funnelId,
      domainId,
      user.organizationId,
      user.userId,
    );
    return { data: domain };
  }
}
