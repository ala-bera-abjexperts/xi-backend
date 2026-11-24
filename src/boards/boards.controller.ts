/**
 * @fileoverview REST controller for `/boards` — board + columns + swimlanes
 * + card-fields + quick-filters + card operations.
 * @module src/boards/boards.controller
 * @author Prince Jadiya
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
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
import { BoardsService } from './boards.service';
import { CreateBoardDto } from './dto/create-board.dto';
import { UpdateBoardDto } from './dto/update-board.dto';
import { CreateColumnDto } from './dto/create-column.dto';
import { UpdateColumnDto } from './dto/update-column.dto';
import { MoveCardDto } from './dto/move-card.dto';
import { ReorderCardsDto } from './dto/reorder-cards.dto';

@RequireFeature('module_boards')
@ApiTags('Boards')
@ApiBearerAuth()
@Controller('boards')
export class BoardsController {
  constructor(private readonly service: BoardsService) {}

  // ── Board CRUD ──────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List boards' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'boardType', required: false })
  @ApiQuery({ name: 'isArchived', required: false })
  @ApiQuery({ name: 'search', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: Record<string, string | undefined>,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ) {
    return this.service.getAll(
      user.organizationId,
      user.userId,
      spaceId ?? query['space_id'] ?? '',
      {
        board_type: query['boardType'] ?? query['board_type'],
        is_archived: query['isArchived'] ?? query['is_archived'],
        search: query['search'],
      },
      Number(query['page'] ?? 1),
      Number(query['pageSize'] ?? query['page_size'] ?? 20),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a board' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateBoardDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Post(':id/refresh')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Sync all space tasks onto the board' })
  async refreshBoard(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.refreshBoard(id, user.organizationId, user.userId);
  }

  @Get(':id/view')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Get board render view data' })
  async getView(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getById(
      id,
      user.organizationId,
      user.userId,
    );
    return { data };
  }

  @Get(':id')
  @ApiParam({ name: 'id' })
  @ApiOperation({
    summary:
      'Get board detail with columns, swimlanes, card-fields, quick-filters',
  })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const view = await this.service.getById(
      id,
      user.organizationId,
      user.userId,
    );

    return {
      data: {
        ...view.board,
        columns: view.columns,
        swimlanes: view.swimlanes,
        card_fields: view.card_fields,
        quick_filters: view.quick_filters,
      },
    };
  }

  @Patch(':id')
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBoardDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Delete(':id')
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Board deleted' };
  }

  @Post(':id/archive')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Archive a board' })
  async archive(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.archiveBoard(id, user.organizationId, user.userId);
  }

  @Delete(':id/archive')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Restore an archived board' })
  async unarchive(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.unarchiveBoard(id, user.organizationId, user.userId);
  }

  // ── Columns ─────────────────────────────────────────────────────────────────

  @Post(':id/columns')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Add a column to the board' })
  async createColumn(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateColumnDto,
  ) {
    return this.service.createColumn(id, user.organizationId, user.userId, dto);
  }

  @Patch(':id/columns/:columnId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'columnId' })
  async updateColumn(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('columnId', ParseUUIDPipe) columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.service.updateColumn(
      id,
      columnId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':id/columns/:columnId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'columnId' })
  @ApiQuery({
    name: 'target_column_id',
    required: false,
    description: 'UUID of column to receive cards from the deleted column',
  })
  async removeColumn(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('columnId', ParseUUIDPipe) columnId: string,
    @Query() query: Record<string, string | undefined>,
    @Query('target_column_id', new ParseUUIDPipe({ optional: true }))
    targetColumnId?: string,
  ) {
    await this.service.deleteColumn(
      id,
      columnId,
      user.organizationId,
      user.userId,
      targetColumnId ?? query['targetColumnId'],
    );
    return { success: true, message: 'Column deleted' };
  }

  // PUT /reorder MUST appear before PATCH /:columnId to avoid NestJS matching "reorder" as UUID
  @Put(':id/columns/reorder')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Reorder columns on a board' })
  async reorderColumns(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { columns: { id: string; sort_order: number }[] },
  ) {
    await this.service.reorderColumns(
      id,
      user.organizationId,
      user.userId,
      body.columns,
    );
    return { success: true };
  }

  // ── Status mappings ──────────────────────────────────────────────────────────

  @Get(':id/statuses/unmapped')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Get statuses not yet mapped to any column' })
  async getUnmappedStatuses(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getUnmappedStatuses(
      id,
      user.organizationId,
      user.userId,
    );
    return { data };
  }

  @Post(':id/statuses')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Map a status to a board column' })
  async mapStatus(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { column_id: string; status_id: string; sort_order?: number },
  ) {
    const data = await this.service.mapStatusToColumn(
      id,
      user.organizationId,
      user.userId,
      body,
    );
    return { data, success: true };
  }

  @Delete(':id/statuses/:mappingId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'mappingId' })
  @ApiOperation({ summary: 'Remove a status-to-column mapping' })
  async unmapStatus(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
  ) {
    await this.service.unmapStatus(
      id,
      user.organizationId,
      user.userId,
      mappingId,
    );
    return { success: true, message: 'Status unmapped' };
  }

  // ── User state — column collapse ──────────────────────────────────────────────

  @Post(':id/user-state/columns/:columnId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'columnId' })
  @ApiOperation({
    summary: 'Toggle column collapse state for the current user',
  })
  async toggleColumnCollapse(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('columnId', ParseUUIDPipe) columnId: string,
  ) {
    const data = await this.service.toggleColumnCollapse(
      id,
      columnId,
      user.userId,
      user.organizationId,
    );
    return { data };
  }

  // ── Swimlanes ───────────────────────────────────────────────────────────────

  @Get(':id/swimlanes')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'List swimlanes for a board' })
  async getSwimlanes(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getSwimlanes(id, user.organizationId, user.userId);
  }

  @Post(':id/swimlanes')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Add a swimlane to the board' })
  async createSwimlane(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      name: string;
      query?: string;
      sort_order?: number;
      is_default?: boolean;
    },
  ) {
    return this.service.createSwimlane(
      id,
      user.organizationId,
      user.userId,
      body,
    );
  }

  // PUT /reorder MUST appear before PATCH /:swimlaneId to avoid NestJS matching "reorder" as UUID
  @Put(':id/swimlanes/reorder')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Reorder swimlanes' })
  async reorderSwimlanes(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { swimlanes: { id: string; sort_order: number }[] },
  ) {
    await this.service.reorderSwimlanes(
      id,
      user.organizationId,
      user.userId,
      body.swimlanes,
    );
    return { success: true };
  }

  @Patch(':id/swimlanes/:swimlaneId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'swimlaneId' })
  async updateSwimlane(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('swimlaneId', ParseUUIDPipe) swimlaneId: string,
    @Body()
    body: {
      name?: string;
      query?: string;
      sort_order?: number;
      is_default?: boolean;
    },
  ) {
    return this.service.updateSwimlane(
      id,
      swimlaneId,
      user.organizationId,
      user.userId,
      body,
    );
  }

  @Delete(':id/swimlanes/:swimlaneId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'swimlaneId' })
  async deleteSwimlane(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('swimlaneId', ParseUUIDPipe) swimlaneId: string,
  ) {
    await this.service.deleteSwimlane(
      id,
      swimlaneId,
      user.organizationId,
      user.userId,
    );
    return { success: true };
  }

  // ── Card Fields ─────────────────────────────────────────────────────────────

  @Get(':id/card-fields')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Get card fields configured for the board' })
  async getCardFields(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getCardFields(id, user.organizationId, user.userId);
  }

  @Put(':id/card-fields')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Replace card fields for the board (atomic)' })
  async setCardFields(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      fields: {
        custom_field_id: string;
        position: number;
        width?: string;
        color?: string;
      }[];
    },
  ) {
    return this.service.setCardFields(
      id,
      user.organizationId,
      user.userId,
      body.fields,
    );
  }

  // ── Quick Filters ───────────────────────────────────────────────────────────

  @Get(':id/quick-filters')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'List quick filters for the board' })
  async getQuickFilters(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getQuickFilters(id, user.organizationId, user.userId);
  }

  @Post(':id/quick-filters')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Add a quick filter to the board' })
  async createQuickFilter(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      name: string;
      query?: string;
      description?: string;
      sort_order?: number;
      is_enabled?: boolean;
    },
  ) {
    return this.service.createQuickFilter(
      id,
      user.organizationId,
      user.userId,
      body,
    );
  }

  // PUT /reorder MUST appear before PATCH /:filterId to avoid NestJS matching "reorder" as UUID
  @Put(':id/quick-filters/reorder')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Reorder quick filters' })
  async reorderQuickFilters(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      filters?: { id: string; sort_order: number }[];
      quick_filters?: { id: string; sort_order: number }[];
    },
  ) {
    await this.service.reorderQuickFilters(
      id,
      user.organizationId,
      user.userId,
      body.filters ?? body.quick_filters ?? [],
    );
    return { success: true };
  }

  @Patch(':id/quick-filters/:filterId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'filterId' })
  async updateQuickFilter(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body()
    body: {
      name?: string;
      query?: string;
      description?: string;
      sort_order?: number;
      is_enabled?: boolean;
    },
  ) {
    return this.service.updateQuickFilter(
      id,
      filterId,
      user.organizationId,
      user.userId,
      body,
    );
  }

  @Delete(':id/quick-filters/:filterId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'filterId' })
  async deleteQuickFilter(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
  ) {
    await this.service.deleteQuickFilter(
      id,
      filterId,
      user.organizationId,
      user.userId,
    );
    return { success: true };
  }

  @Put(':id/user-state/quick-filters/:filterId')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'filterId' })
  @ApiOperation({ summary: 'Set quick filter active state' })
  async setQuickFilterActive(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body() body: { is_active: boolean },
  ) {
    return this.service.setQuickFilterActive(
      id,
      filterId,
      user.userId,
      user.organizationId,
      body.is_active,
    );
  }

  // ── Card Operations ─────────────────────────────────────────────────────────

  @Post(':id/cards')
  @ApiParam({ name: 'id' })
  @ApiOperation({
    summary: 'Add a task card to this board (inserts board_issue_ranking row)',
  })
  async addCard(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      task_id: string;
      column_id: string;
      position: number;
      sprint_id?: string | null;
    },
  ) {
    return this.service.addCard(id, user.organizationId, user.userId, body);
  }

  @Post(':id/cards/add')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Add a task card to this board (legacy path)' })
  async addCardLegacy(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      task_id: string;
      column_id: string;
      position?: number;
      sprint_id?: string | null;
    },
  ) {
    return this.service.addCard(id, user.organizationId, user.userId, {
      ...body,
      position: body.position ?? 1000,
    });
  }

  @Post(':id/cards/move')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Move a card across columns (optimistic lock)' })
  async moveCard(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveCardDto,
  ) {
    return this.service.moveCard(id, user.organizationId, user.userId, dto);
  }

  @Put(':id/cards/reorder')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Reorder cards within a single column' })
  async reorderCards(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderCardsDto,
  ) {
    await this.service.reorderCards(id, user.organizationId, user.userId, dto);
    return { success: true };
  }
}
