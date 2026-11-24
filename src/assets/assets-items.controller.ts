import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsItemsService } from './assets-items.service';
import { CreateAssetItemDto } from './dto/create-asset-item.dto';
import { UpdateAssetItemDto } from './dto/update-asset-item.dto';
import {
  BulkUpdateItemsDto,
  BulkItemIdsDto,
} from './dto/bulk-update-items.dto';
import { ReorderItemsDto } from './dto/reorder-items.dto';
import { UpdateCustomFieldValuesDto } from './dto/update-custom-fields-values.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Items (List Records)')
@ApiBearerAuth()
// SECURITY (H2): require space membership + list view. The services scope by org
// only, so previously any org member could CRUD list records in private spaces
// they aren't a member of. Every space role includes view_lists, so no legit
// access is broken; non-members are now correctly rejected.
@UseGuards(SpacePermissionsGuard)
@RequireSpacePermission('can_view_lists')
@Controller('spaces/:spaceId/lists/items')
export class AssetsItemsController {
  constructor(private readonly service: AssetsItemsService) {}

  // ── Static sub-paths before /:itemId ──────────────────────────────────────

  @Put('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk update cells across multiple items' })
  @ApiParam({ name: 'spaceId' })
  async bulkUpdate(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: BulkUpdateItemsDto,
  ) {
    return this.service.bulkUpdate(
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk delete items' })
  @ApiParam({ name: 'spaceId' })
  async bulkDelete(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkItemIdsDto,
  ) {
    return this.service.bulkDelete(user.organizationId, user.userId, dto);
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk archive items' })
  @ApiParam({ name: 'spaceId' })
  async bulkArchive(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkItemIdsDto,
  ) {
    return this.service.bulkArchive(user.organizationId, user.userId, dto);
  }

  @Put('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder items within a schema' })
  @ApiParam({ name: 'spaceId' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderItemsDto,
  ) {
    return this.service.reorder(user.organizationId, user.userId, dto);
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List items with pagination and filters' })
  @ApiParam({ name: 'spaceId' })
  @ApiQuery({ name: 'schemaId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'page_size', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'sort_column', required: false })
  @ApiQuery({ name: 'sort_direction', required: false })
  @ApiQuery({ name: 'is_archived', required: false })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query('schemaId') schemaId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('search') search?: string,
    @Query('sort_column') sortColumn?: string,
    @Query('sort_direction') sortDirection?: string,
    @Query('is_archived') isArchived?: string,
  ) {
    return this.service.getAll(spaceId, user.organizationId, {
      schemaId,
      page: page ? parseInt(page, 10) : undefined,
      page_size: pageSize ? parseInt(pageSize, 10) : undefined,
      search,
      sort_column: sortColumn,
      sort_direction: sortDirection,
      is_archived: isArchived,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a list item' })
  @ApiParam({ name: 'spaceId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateAssetItemDto,
  ) {
    return this.service.create(spaceId, user.organizationId, user.userId, dto);
  }

  @Get(':itemId')
  @ApiOperation({ summary: 'Get item by ID' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getById(itemId, user.organizationId);
  }

  @Put(':itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update item (optimistic locking via version)' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateAssetItemDto,
  ) {
    return this.service.update(itemId, user.organizationId, user.userId, dto);
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard delete an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.delete(itemId, user.organizationId, user.userId);
  }

  // ── Sub-resources ─────────────────────────────────────────────────────────

  @Get(':itemId/history')
  @ApiOperation({ summary: 'Get item audit trail' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'page_size', required: false })
  async getHistory(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
  ) {
    return this.service.getHistory(
      itemId,
      user.organizationId,
      page ? parseInt(page, 10) : undefined,
      pageSize ? parseInt(pageSize, 10) : undefined,
    );
  }

  @Get(':itemId/custom-fields')
  @ApiOperation({ summary: 'Get custom field values for an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async getCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getCustomFieldValues(itemId, user.organizationId);
  }

  @Put(':itemId/custom-fields')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update custom field values for an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async updateCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateCustomFieldValuesDto,
  ) {
    return this.service.updateCustomFieldValues(
      itemId,
      user.organizationId,
      user.userId,
      dto,
    );
  }
}
