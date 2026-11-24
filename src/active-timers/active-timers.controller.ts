import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { ActiveTimersService } from './active-timers.service';
import { StartTimerDto } from './dto/start-timer.dto';
import { StopTimerDto } from './dto/stop-timer.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@ApiTags('Active Timers')
@ApiBearerAuth()
@Controller('active-timers')
export class ActiveTimersController {
  constructor(private readonly service: ActiveTimersService) {}

  /** GET /active-timers — returns current user's active timer or null */
  @Get()
  @ApiOperation({ summary: "Get current user's active timer" })
  async getTimer(@CurrentUser() user: RequestUser) {
    const data = await this.service.getTimer(user.userId);
    return { data };
  }

  /** POST /active-timers — start a timer on a task */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a timer on a task' })
  async startTimer(
    @CurrentUser() user: RequestUser,
    @Body() body: StartTimerDto,
  ) {
    const taskId = body.task_id ?? body.taskId;
    if (!taskId) {
      throw new BadRequestException('taskId and organizationId are required');
    }

    const data = await this.service.startTimer(
      user.userId,
      taskId,
      user.organizationId,
    );
    return { data, success: true };
  }

  /** DELETE /active-timers/:id — stop timer, create time entry */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop timer and log a time entry' })
  @ApiParam({ name: 'id' })
  async stopTimer(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StopTimerDto,
  ) {
    const data = await this.service.stopTimer(
      id,
      user.userId,
      user.organizationId,
      body.note,
    );
    return { data, success: true };
  }
}
