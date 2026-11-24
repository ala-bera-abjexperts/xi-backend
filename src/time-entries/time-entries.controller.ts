import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { TimeEntriesService } from './time-entries.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import { UpdateTimeEntryDto } from './dto/update-time-entry.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@ApiTags('Time Entries')
@ApiBearerAuth()
@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly service: TimeEntriesService) {}

  /**
   * GET /time-entries?taskId=xxx
   * GET /time-entries?userId=xxx
   */
  @Get()
  @ApiOperation({ summary: 'List time entries by task or user' })
  @ApiQuery({ name: 'taskId', required: false })
  @ApiQuery({ name: 'userId', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('taskId') taskId?: string,
    @Query('userId') userId?: string,
  ) {
    if (!taskId && !userId) {
      throw new BadRequestException('taskId or userId query param is required');
    }

    if (userId) {
      const data = await this.service.getEntriesForUser(
        userId,
        user.organizationId,
      );
      return { data, count: data.length };
    }

    const data = await this.service.getEntriesForTask(
      taskId!,
      user.organizationId,
    );
    return { data, count: data.length };
  }

  /** POST /time-entries */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a time entry (auto-syncs task actual_time)',
  })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() body: CreateTimeEntryDto,
  ) {
    const taskId = body.task_id ?? body.taskId;
    if (!taskId) {
      throw new BadRequestException('task_id is required');
    }

    const data = await this.service.createEntry(
      { ...body, task_id: taskId },
      user.userId,
      user.organizationId,
    );
    return { data, success: true };
  }

  /** PUT /time-entries/:id */
  @Put(':id')
  @ApiOperation({ summary: 'Update a time entry (own entries only)' })
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTimeEntryDto,
  ) {
    const data = await this.service.updateEntry(id, body, user.userId);
    return { data, success: true };
  }

  /** DELETE /time-entries/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a time entry (own entries only)' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteEntry(id, user.userId);
    return { success: true };
  }
}
