/**
 * @fileoverview REST controller for `/resolutions`.
 * @module src/resolutions/resolutions.controller
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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ResolutionsService } from './resolutions.service';
import { CreateResolutionDto } from './dto/create-resolution.dto';
import { UpdateResolutionDto } from './dto/update-resolution.dto';
import { ReorderResolutionsDto } from './dto/reorder-resolutions.dto';

@ApiTags('Resolutions')
@ApiBearerAuth()
@Controller('resolutions')
export class ResolutionsController {
  constructor(private readonly service: ResolutionsService) {}

  @Get()
  @ApiOperation({ summary: 'List resolutions for the org' })
  @ApiResponse({ status: 200, description: 'Resolutions returned' })
  async list(@CurrentUser() user: RequestUser) {
    const data = await this.service.getAll(user.organizationId);

    return { data, count: data.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_resolutions', 'can_create_resolutions'], {
    any: true,
  })
  @ApiOperation({ summary: 'Create a resolution' })
  @ApiResponse({ status: 201, description: 'Resolution created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateResolutionDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a resolution by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Resolution returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.service.getById(id, user.organizationId) };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_resolutions', 'can_edit_resolutions'], {
    any: true,
  })
  @ApiOperation({ summary: 'Update a resolution' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Resolution updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResolutionDto,
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
  @RequirePermissions(['can_manage_resolutions', 'can_delete_resolutions'], {
    any: true,
  })
  @ApiOperation({ summary: 'Delete a resolution' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Resolution deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Resolution deleted' };
  }

  @Patch('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_resolutions', 'can_edit_resolutions'], {
    any: true,
  })
  @ApiOperation({ summary: 'Bulk reorder resolutions' })
  @ApiResponse({ status: 200, description: 'Resolutions reordered' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderResolutionsDto,
  ) {
    await this.service.reorder(dto.items, user.organizationId, user.userId);

    return { success: true, message: 'Resolutions reordered' };
  }

  @Patch(':id/set-default')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_resolutions', 'can_edit_resolutions'], {
    any: true,
  })
  @ApiOperation({ summary: 'Set a resolution as the default' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Default resolution set' })
  async setDefault(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      data: await this.service.setDefault(id, user.organizationId, user.userId),
      success: true,
    };
  }
}
