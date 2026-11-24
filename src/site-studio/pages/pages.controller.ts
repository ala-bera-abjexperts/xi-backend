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
import { CreatePageDto } from './dto/create-page.dto';
import { MovePageDto } from './dto/move-page.dto';
import { ReorderPagesDto } from './dto/reorder-pages.dto';
import { SaveContentDto } from './dto/save-content.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PagesService } from './pages.service';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Pages')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels/:funnelId/pages')
export class PagesController {
  constructor(private readonly service: PagesService) {}

  // ── List ─────────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({
    summary: 'List all pages for a funnel ordered by sort_order',
  })
  @ApiParam({ name: 'funnelId' })
  async getPages(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    const pages = await this.service.getPages(funnelId, user.organizationId);
    return { data: pages };
  }

  // ── Reorder — must be before :pageId ─────────────────────────────────────────

  @Put('reorder')
  @RequirePermissions('can_edit_site_studio')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reorder pages within a funnel' })
  @ApiParam({ name: 'funnelId' })
  async reorderPages(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: ReorderPagesDto,
  ) {
    await this.service.reorderPages(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ── Single page ───────────────────────────────────────────────────────────────

  @Get(':pageId')
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'Get a single page by ID' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async getPageById(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    const page = await this.service.getPageById(
      funnelId,
      pageId,
      user.organizationId,
    );
    return { data: page };
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Create a new page in a funnel' })
  @ApiParam({ name: 'funnelId' })
  async createPage(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: CreatePageDto,
  ) {
    const page = await this.service.createPage(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: page };
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  @Put(':pageId')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({
    summary: 'Update page metadata (name, path, SEO, published)',
  })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async updatePage(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    const page = await this.service.updatePage(
      funnelId,
      pageId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: page };
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  @Delete(':pageId')
  @RequirePermissions('can_delete_site_studio')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a page (cannot delete the last page of a funnel)',
  })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async deletePage(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    await this.service.deletePage(
      funnelId,
      pageId,
      user.organizationId,
      user.userId,
    );
  }

  // ── Duplicate ─────────────────────────────────────────────────────────────────

  @Post(':pageId/duplicate')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Duplicate a page with a unique path' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async duplicatePage(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    const page = await this.service.duplicatePage(
      funnelId,
      pageId,
      user.organizationId,
      user.userId,
    );
    return { data: page };
  }

  // ── Move (rename path) ────────────────────────────────────────────────────────

  @Put(':pageId/move')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({ summary: 'Change the path_name of a page' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async movePage(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: MovePageDto,
  ) {
    const page = await this.service.movePage(
      funnelId,
      pageId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: page };
  }

  // ── Save content ──────────────────────────────────────────────────────────────

  @Put(':pageId/content')
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({
    summary: 'Save the page editor content (EditorElement tree)',
  })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'pageId' })
  async saveContent(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: SaveContentDto,
  ) {
    const page = await this.service.saveContent(
      funnelId,
      pageId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: page };
  }
}
