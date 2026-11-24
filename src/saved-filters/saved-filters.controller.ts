import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  BadRequestException,
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
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SavedFiltersService } from './saved-filters.service';
import { CreateSavedFilterDto } from './dto/create-saved-filter.dto';
import { UpdateSavedFilterDto } from './dto/update-saved-filter.dto';
import { SetFilterPermissionsDto } from './dto/set-filter-permissions.dto';
import { CreateFilterSubscriptionDto } from './dto/create-filter-subscription.dto';
import { ExecuteFilterDto } from './dto/execute-filter.dto';
import { ExecuteSavedFilterDto } from './dto/execute-saved-filter.dto';

const PARENT_OPTION_ENTITY_TYPES = ['tasks', 'processes'] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@RequireFeature('module_filters')
@ApiTags('Saved Filters')
@ApiBearerAuth()
@Controller('filters')
export class SavedFiltersController {
  constructor(private readonly service: SavedFiltersService) {}

  // ── Static sub-paths first ────────────────────────────────────────────────

  @Get('defaults')
  @ApiOperation({ summary: 'Get system default filters' })
  async getDefaults(@CurrentUser() user: RequestUser) {
    return this.service.getDefaults(user.organizationId);
  }

  @Get('fields')
  @ApiOperation({ summary: 'Get filterable field definitions' })
  @ApiQuery({ name: 'entityTypes', required: false })
  @ApiQuery({ name: 'spaceIds', required: false })
  async getFields(
    @CurrentUser() user: RequestUser,
    @Query('entityTypes') entityTypes?: string,
    @Query('spaceIds') spaceIds?: string,
  ) {
    const entityTypeArr = entityTypes
      ? entityTypes.split(',').filter(Boolean)
      : ['processes', 'tasks', 'lists'];
    const spaceIdsArr = spaceIds
      ? spaceIds.split(',').filter(Boolean)
      : undefined;
    return this.service.getFilterableFields(
      user.organizationId,
      user.userId,
      entityTypeArr,
      spaceIdsArr,
    );
  }

  @Get('parent-options')
  @ApiOperation({
    summary: 'Typeahead: tasks + processes matching search (for Parent field)',
  })
  @ApiQuery({ name: 'search', required: true })
  @ApiQuery({ name: 'entityTypes', required: false })
  @ApiQuery({ name: 'spaceIds', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async getParentOptions(
    @CurrentUser() user: RequestUser,
    @Query('search') search: string,
    @Query('entityTypes') entityTypes?: string,
    @Query('spaceIds') spaceIds?: string,
    @Query('limit') limitStr?: string,
  ) {
    const trimmedSearch = search?.trim() ?? '';
    if (!trimmedSearch || trimmedSearch.length > 200) {
      throw new BadRequestException('Invalid query parameters');
    }

    const entityTypeArr = entityTypes
      ? entityTypes
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : ['tasks', 'processes'];
    if (
      entityTypeArr.length === 0 ||
      entityTypeArr.some(
        (entityType) =>
          !(PARENT_OPTION_ENTITY_TYPES as readonly string[]).includes(
            entityType,
          ),
      )
    ) {
      throw new BadRequestException('Invalid query parameters');
    }

    const spaceIdsArr = spaceIds
      ? spaceIds
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    if (spaceIdsArr.some((spaceId) => !UUID_RE.test(spaceId))) {
      throw new BadRequestException('Invalid query parameters');
    }

    const limit = limitStr === undefined ? 20 : Number(limitStr);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('Invalid query parameters');
    }

    return this.service.getParentOptions(
      user.organizationId,
      user.userId,
      trimmedSearch,
      entityTypeArr,
      spaceIdsArr,
      limit,
    );
  }

  @Post('execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute an ad-hoc filter (no save)' })
  async executeAdHoc(
    @CurrentUser() user: RequestUser,
    @Body() dto: ExecuteFilterDto,
  ) {
    return this.service.executeAdHoc(dto, user.organizationId, user.userId);
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List accessible filters' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'visibility', required: false })
  @ApiQuery({ name: 'is_favorite', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('search') search?: string,
    @Query('visibility') visibility?: string,
    @Query('is_favorite') isFavorite?: string,
  ) {
    return this.service.getAll(user.organizationId, user.userId, {
      search,
      visibility,
      is_favorite: isFavorite === 'true' ? true : undefined,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a saved filter' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSavedFilterDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a saved filter by ID' })
  @ApiParam({ name: 'id' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(id, user.organizationId, user.userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a saved filter' })
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedFilterDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a saved filter' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(id, user.organizationId, user.userId);
  }

  // ── Favorite ──────────────────────────────────────────────────────────────

  @Post(':id/favorite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle favorite on a filter' })
  @ApiParam({ name: 'id' })
  async toggleFavorite(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.toggleFavorite(id, user.organizationId, user.userId);
  }

  // ── Execute / Export ──────────────────────────────────────────────────────

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute a saved filter' })
  @ApiParam({ name: 'id' })
  async executeSaved(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExecuteSavedFilterDto,
  ) {
    return this.service.executeFilter(id, user.organizationId, user.userId, {
      page: dto.page ?? 1,
      pageSize: dto.pageSize ?? 50,
      sort: dto.sort,
    });
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export filter results as CSV' })
  @ApiParam({ name: 'id' })
  async exportCsv(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const csv = await this.service.exportToCSV(
      id,
      user.organizationId,
      user.userId,
    );
    const { data: filter } = await this.service.getById(
      id,
      user.organizationId,
      user.userId,
    );
    // The RFC 5987 helper carries the ORIGINAL filter name (umlauts and all) in filename*= while
    // keeping the header value ASCII — the old `[^\w\s-]` strip turned "Änderungen" into "nderungen".
    const name =
      ((filter['name'] as string) || 'filter-export').trim() || 'filter-export';
    const date = new Date().toISOString().split('T')[0];
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDispositionAttachment(
        `${name}-${date}.csv`,
      ),
    });
    res.send(csv);
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  @Get(':id/permissions')
  @ApiOperation({ summary: 'List permissions for a filter (owner only)' })
  @ApiParam({ name: 'id' })
  async getPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getPermissions(id, user.organizationId, user.userId);
  }

  @Post(':id/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set permissions for a filter (owner only, replaces all)',
  })
  @ApiParam({ name: 'id' })
  async setPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFilterPermissionsDto,
  ) {
    return this.service.setPermissions(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  @Get(':id/subscriptions')
  @ApiOperation({ summary: 'List subscriptions for a filter' })
  @ApiParam({ name: 'id' })
  async getSubscriptions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getSubscriptions(id, user.organizationId, user.userId);
  }

  @Post(':id/subscriptions')
  @ApiOperation({ summary: 'Create or update subscription for a filter' })
  @ApiParam({ name: 'id' })
  async createSubscription(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFilterSubscriptionDto,
  ) {
    return this.service.createSubscription(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':id/subscriptions/:subId')
  @ApiOperation({ summary: 'Delete a filter subscription' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'subId' })
  async deleteSubscription(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('subId', ParseUUIDPipe) subId: string,
  ) {
    return this.service.deleteSubscription(
      id,
      subId,
      user.organizationId,
      user.userId,
    );
  }
}
