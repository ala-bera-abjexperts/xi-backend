/**
 * @fileoverview Staff routes for "request more information with a form" (XE-T546 §8).
 * Gated like customer-reply publishing: `publish_customer_replies` on the task's space,
 * enforced in {@link SlaFormRequestsService} via `SlaAccessService.authorizeTask`.
 * @module src/sla/sla-form-requests.controller
 * @author Prince Jadiya
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SlaFormRequestsService } from './sla-form-requests.service';

class CreateFormRequestDto {
  @IsUUID() form_id!: string;
}

@Controller('sla/tasks/:taskId/form-requests')
export class SlaFormRequestsController {
  constructor(private readonly formRequests: SlaFormRequestsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.formRequests.listForTask(user, taskId);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateFormRequestDto,
  ) {
    return this.formRequests.createForTask(user, taskId, dto.form_id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.formRequests.cancel(user, taskId, id);
  }
}
