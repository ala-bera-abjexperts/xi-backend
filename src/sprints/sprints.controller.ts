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
import { SprintsService } from './sprints.service';
import { CreateSprintDto } from './dto/create-sprint.dto';
import { UpdateSprintDto } from './dto/update-sprint.dto';
import { StartSprintDto } from './dto/start-sprint.dto';
import { CompleteSprintDto } from './dto/complete-sprint.dto';
import { ReorderBacklogDto } from './dto/reorder-backlog.dto';
import { MoveTasksDto } from './dto/move-tasks.dto';

@RequireFeature('module_boards')
@ApiTags('Sprints')
@ApiBearerAuth()
@Controller('boards/:boardId/sprints')
export class SprintsController {
  constructor(private readonly service: SprintsService) {}

  // ── Static sub-paths (must be before /:sprintId) ─────────────────────────

  @Get('backlog')
  @ApiOperation({
    summary: 'Get backlog view with sprint tasks (scrum boards only)',
  })
  @ApiParam({ name: 'boardId' })
  async getBacklog(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
  ) {
    return this.service.getBacklogView(
      boardId,
      user.organizationId,
      user.userId,
    );
  }

  @Put('backlog/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder tasks in the backlog' })
  @ApiParam({ name: 'boardId' })
  async reorderBacklog(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: ReorderBacklogDto,
  ) {
    return this.service.reorderBacklog(
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Post('move-tasks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move tasks between sprints or to backlog' })
  @ApiParam({ name: 'boardId' })
  async moveTasks(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: MoveTasksDto,
  ) {
    return this.service.moveTasksToSprint(
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List sprints for a board' })
  @ApiParam({ name: 'boardId' })
  @ApiQuery({ name: 'include_completed', required: false })
  async getSprints(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Query('include_completed') includeCompleted?: string,
    @Query('includeCompleted') includeCompletedCamel?: string,
  ) {
    return this.service.getSprints(
      boardId,
      user.organizationId,
      user.userId,
      (includeCompleted ?? includeCompletedCamel) === 'true',
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a sprint' })
  @ApiParam({ name: 'boardId' })
  async createSprint(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: CreateSprintDto,
  ) {
    return this.service.createSprint(
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Get(':sprintId')
  @ApiOperation({ summary: 'Get sprint by ID' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'sprintId' })
  async getSprintById(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
  ) {
    return this.service.getSprintById(
      boardId,
      sprintId,
      user.organizationId,
      user.userId,
    );
  }

  @Patch(':sprintId')
  @ApiOperation({ summary: 'Update sprint fields' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'sprintId' })
  async updateSprint(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
    @Body() dto: UpdateSprintDto,
  ) {
    return this.service.updateSprint(
      sprintId,
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':sprintId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a sprint (planning status only)' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'sprintId' })
  async deleteSprint(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
  ) {
    return this.service.deleteSprint(
      sprintId,
      boardId,
      user.organizationId,
      user.userId,
    );
  }

  // ── Sprint lifecycle ──────────────────────────────────────────────────────

  @Post(':sprintId/start')
  @ApiOperation({ summary: 'Start a sprint (planning → active)' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'sprintId' })
  async startSprint(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
    @Body() dto: StartSprintDto,
  ) {
    return this.service.startSprint(
      sprintId,
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Post(':sprintId/complete')
  @ApiOperation({ summary: 'Complete a sprint and handle incomplete tasks' })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'sprintId' })
  async completeSprint(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
    @Body() dto: CompleteSprintDto,
  ) {
    return this.service.completeSprint(
      sprintId,
      boardId,
      user.organizationId,
      user.userId,
      dto,
    );
  }
}
