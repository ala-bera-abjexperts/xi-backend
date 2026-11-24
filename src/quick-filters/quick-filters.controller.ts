import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateQuickFilterDto } from './dto/create-quick-filter.dto';
import { ReorderQuickFiltersDto } from './dto/reorder-quick-filters.dto';
import { UpdateQuickFilterDto } from './dto/update-quick-filter.dto';
import { QuickFiltersService } from './quick-filters.service';

@RequireFeature('module_boards')
@ApiTags('Board Quick Filters')
@ApiBearerAuth()
@Controller('boards/:boardId/quick-filters')
export class QuickFiltersController {
  constructor(private readonly service: QuickFiltersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Create a quick filter for a board' })
  @ApiParam({ name: 'boardId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: CreateQuickFilterDto,
  ) {
    return this.service.create(boardId, user.organizationId, user.userId, dto);
  }

  @Put('reorder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Reorder quick filters for a board' })
  @ApiParam({ name: 'boardId' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: ReorderQuickFiltersDto,
  ) {
    return this.service.reorder(boardId, user.organizationId, user.userId, dto);
  }

  @Patch(':filterId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Update a quick filter' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'filterId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body() dto: UpdateQuickFilterDto,
  ) {
    return this.service.update(
      filterId,
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':filterId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Delete a quick filter' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'filterId' })
  async delete(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
  ) {
    return this.service.delete(
      filterId,
      boardId,
      user.organizationId,
      user.userId,
    );
  }
}
