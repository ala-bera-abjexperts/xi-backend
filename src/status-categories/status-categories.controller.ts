/**
 * @fileoverview REST controller for `/status-categories`.
 * @module src/status-categories/status-categories.controller
 * @author Rajbha Manek
 */
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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { StatusCategoriesService } from './status-categories.service';
import { CreateStatusCategoryDto } from './dto/create-status-category.dto';
import { UpdateStatusCategoryDto } from './dto/update-status-category.dto';
import { ReorderStatusCategoriesDto } from './dto/reorder-status-categories.dto';

@ApiTags('Status Categories')
@ApiBearerAuth()
@Controller('status-categories')
export class StatusCategoriesController {
  constructor(private readonly service: StatusCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List status categories for the org' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Categories returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ) {
    const data = await this.service.getAll(user.organizationId, spaceId);

    return { data, count: data.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(
    ['can_manage_status_categories', 'can_create_status_categories'],
    { any: true },
  )
  @ApiOperation({ summary: 'Create a status category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateStatusCategoryDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a status category by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Category returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.service.getById(id, user.organizationId) };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(
    ['can_manage_status_categories', 'can_edit_status_categories'],
    { any: true },
  )
  @ApiOperation({ summary: 'Update a status category' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusCategoryDto,
  ) {
    return {
      data: await this.service.update(
        id,
        user.organizationId,
        dto,
        user.userId,
      ),
      success: true,
    };
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(
    ['can_manage_status_categories', 'can_delete_status_categories'],
    { any: true },
  )
  @ApiOperation({
    summary: 'Delete a status category (blocked if is_system=true)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Category deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Status category deleted' };
  }

  @Patch('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(
    ['can_manage_status_categories', 'can_edit_status_categories'],
    { any: true },
  )
  @ApiOperation({ summary: 'Bulk reorder status categories' })
  @ApiResponse({ status: 200, description: 'Categories reordered' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderStatusCategoriesDto,
  ) {
    await this.service.reorder(dto.items, user.organizationId, user.userId);
    return { success: true, message: 'Categories reordered' };
  }
}
