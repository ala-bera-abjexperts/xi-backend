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
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SpaceTypesService } from './space-types.service';
import { CreateSpaceTypeDto } from './dto/create-space-type.dto';
import { UpdateSpaceTypeDto } from './dto/update-space-type.dto';
import { PatchSpaceTypeDto } from './dto/patch-space-type.dto';

@ApiTags('Space Types')
@ApiBearerAuth()
@Controller('space-types')
export class SpaceTypesController {
  constructor(private readonly service: SpaceTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List space types for the organization' })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'is_deleted', required: false })
  @ApiQuery({ name: 'search', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('is_active') isActive?: string,
    @Query('is_deleted') isDeleted?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getAll(user.organizationId, {
      is_active:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      is_deleted:
        isDeleted === 'true' ? true : isDeleted === 'false' ? false : undefined,
      search,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Create a space type' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSpaceTypeDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a space type by ID' })
  @ApiParam({ name: 'id' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(id, user.organizationId);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Update a space type' })
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSpaceTypeDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Soft-delete a space type' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(id, user.organizationId, user.userId);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_settings')
  @ApiOperation({ summary: 'Actions: restore | toggle_active' })
  @ApiParam({ name: 'id' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchSpaceTypeDto,
  ) {
    if (dto.action === 'restore') {
      return this.service.restore(id, user.organizationId, user.userId);
    }
    return this.service.toggleActive(id, user.organizationId, user.userId);
  }
}
