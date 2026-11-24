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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { FunnelsService } from './funnels.service';
import { ListFunnelsDto } from './dto/list-funnels.dto';
import { CreateFunnelDto } from './dto/create-funnel.dto';
import { UpdateFunnelDto } from './dto/update-funnel.dto';
import { PublishFunnelDto } from './dto/publish-funnel.dto';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Funnels')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels')
export class FunnelsController {
  constructor(private readonly service: FunnelsService) {}

  @Get()
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'List funnels for the organization (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'published', required: false, type: Boolean })
  async getFunnels(
    @CurrentUser() user: RequestUser,
    @Query() dto: ListFunnelsDto,
  ) {
    return this.service.getFunnels(user.organizationId, dto);
  }

  @Get(':funnelId')
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'Get a single funnel with its pages' })
  async getFunnelById(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    const funnel = await this.service.getFunnelById(
      funnelId,
      user.organizationId,
    );
    return { data: funnel };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_create_site_studio')
  @ApiOperation({
    summary: 'Create a funnel (auto-creates Home landing page)',
  })
  async createFunnel(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateFunnelDto,
  ) {
    const funnel = await this.service.createFunnel(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: funnel };
  }

  @Put(':funnelId')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Update a funnel' })
  async updateFunnel(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: UpdateFunnelDto,
  ) {
    const funnel = await this.service.updateFunnel(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );

    return { data: funnel };
  }

  @Delete(':funnelId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_delete_site_studio')
  @ApiOperation({ summary: 'Delete a funnel and all its associated data' })
  async deleteFunnel(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    await this.service.deleteFunnel(funnelId, user.organizationId, user.userId);
    return { data: { success: true } };
  }

  @Post(':funnelId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_publish_site_studio')
  @ApiOperation({
    summary: 'Publish or unpublish a funnel (cascades to all pages)',
  })
  async publishFunnel(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: PublishFunnelDto,
  ) {
    const funnel = await this.service.publishFunnel(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: funnel };
  }
}
