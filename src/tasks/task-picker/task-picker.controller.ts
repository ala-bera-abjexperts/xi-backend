import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  TaskPickerLookupDto,
  TaskPickerSearchQueryDto,
} from './task-picker.dto';
import { TaskPickerService } from './task-picker.service';

/** Debounced search-as-you-type plus refresh bursts; caps a runaway client, not normal use. */
const PICKER_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

/**
 * Task picker reads (whiteboard "Import from Tasks"). Global auth only, like `/tasks/mine/search`:
 * member-space access is enforced in TaskPickerService, never via org-level can_view_tasks.
 * Registered before TasksController so the literal `picker` segment is not captured by `/tasks/:id`.
 */
@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks/picker')
export class TaskPickerController {
  constructor(private readonly picker: TaskPickerService) {}

  @Get('spaces')
  @Throttle(PICKER_THROTTLE)
  @ApiOperation({
    summary:
      'Spaces whose tasks the caller can pick (member + view_tasks, Tasks module on)',
  })
  spaces(@CurrentUser() user: RequestUser) {
    return this.picker.listSpaces(user);
  }

  @Get('search')
  @Throttle(PICKER_THROTTLE)
  @ApiOperation({ summary: 'Search one accessible space’s tasks (paged)' })
  search(
    @CurrentUser() user: RequestUser,
    @Query() q: TaskPickerSearchQueryDto,
  ) {
    return this.picker.search(user, q);
  }

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @Throttle(PICKER_THROTTLE)
  @ApiOperation({
    summary:
      'Current data for task ids the caller can read; others are returned as missing',
  })
  lookup(@CurrentUser() user: RequestUser, @Body() dto: TaskPickerLookupDto) {
    return this.picker.lookup(user, dto.ids);
  }
}
