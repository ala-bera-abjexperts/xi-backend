import { RequireFeature } from '../auth/decorators/require-feature.decorator';
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
import { SwimlanesService } from './swimlanes.service';
import { CreateSwimlaneDto } from './dto/create-swimlane.dto';
import { UpdateSwimlaneDto } from './dto/update-swimlane.dto';
import { ReorderSwimlanesDto } from './dto/reorder-swimlanes.dto';

@RequireFeature('module_boards')
@ApiTags('Board Swimlanes')
@ApiBearerAuth()
@Controller('boards/:boardId/swimlanes')
export class SwimlanesController {
  constructor(private readonly service: SwimlanesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_boards')
  @ApiOperation({ summary: 'List swimlanes for a board' })
  @ApiParam({ name: 'boardId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
  ) {
    return this.service.getAll(boardId, user.organizationId);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Create a swimlane' })
  @ApiParam({ name: 'boardId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: CreateSwimlaneDto,
  ) {
    return this.service.create(boardId, user.organizationId, dto);
  }

  // ── Static sub-path before /:swimlaneId ──────────────────────────────────

  @Put('reorder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Reorder swimlanes' })
  @ApiParam({ name: 'boardId' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: ReorderSwimlanesDto,
  ) {
    return this.service.reorder(boardId, user.organizationId, dto);
  }

  // ── Per-swimlane operations ───────────────────────────────────────────────

  @Patch(':swimlaneId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Update a swimlane' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'swimlaneId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('swimlaneId', ParseUUIDPipe) swimlaneId: string,
    @Body() dto: UpdateSwimlaneDto,
  ) {
    return this.service.update(swimlaneId, boardId, user.organizationId, dto);
  }

  @Delete(':swimlaneId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({ summary: 'Delete a swimlane (non-default only)' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'swimlaneId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('swimlaneId', ParseUUIDPipe) swimlaneId: string,
  ) {
    return this.service.delete(swimlaneId, boardId, user.organizationId);
  }
}
