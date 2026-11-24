/**
 * @fileoverview REST controller for `/notifications` — user-scoped notification management.
 * Supports listing, marking as read, and handling space invitation accept/decline actions.
 * @module src/notifications/notifications.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { NotificationActionDto } from './dto/notification-action.dto';
import { UpsertNotificationPreferenceDto } from './dto/notification-preference.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  /**
   * GET /notifications
   * Returns paginated notifications for the calling user.
   * Response shape: { data: INotification[], total: number }
   */
  @Get()
  @ApiOperation({ summary: 'List notifications for the current user' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<unknown> {
    return this.service.getUserNotifications(
      user.userId,
      user.organizationId,
      query,
    );
  }

  /**
   * GET /notifications/preferences
   * Returns the current user's notification preferences merged with defaults.
   * Response shape: Record<string, { inApp: boolean }>
   * MUST be declared BEFORE parameterised routes to prevent route conflicts.
   */
  @Get('preferences')
  @ApiOperation({
    summary: 'Get notification preferences for the current user',
  })
  async getPreferences(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.getPreferences(user.userId, user.organizationId);
  }

  /**
   * PUT /notifications/preferences
   * Upserts a single notification preference for the current user.
   * Response shape: Record<string, { inApp: boolean }>
   */
  @Put('preferences')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a notification preference' })
  async upsertPreference(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpsertNotificationPreferenceDto,
  ): Promise<unknown> {
    return this.service.upsertPreference(user.userId, user.organizationId, dto);
  }

  /**
   * POST /notifications/mark-all-read
   * Marks all unread notifications for the current user as read.
   * MUST be declared BEFORE POST /notifications/:id/action to prevent route conflicts.
   * Response shape: { success: true }
   */
  @Post('mark-all-read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllRead(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.markAllAsRead(user.userId, user.organizationId);
  }

  /**
   * PATCH /notifications/:id
   * Marks a single notification as read or unread.
   * Verifies that the notification belongs to the calling user.
   * Response shape: the updated notification object
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Mark a notification as read or unread' })
  @ApiParam({ name: 'id', description: 'Notification UUID' })
  async markRead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkReadDto,
  ): Promise<unknown> {
    return this.service.markAsRead(id, user.userId, user.organizationId, dto);
  }

  /**
   * POST /notifications/:id/action
   * Accepts or declines a space_invitation notification.
   * Response shape: { success: true, action: 'accepted'|'declined', space_id: string }
   */
  @Post(':id/action')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept or decline a space invitation notification',
  })
  @ApiParam({ name: 'id', description: 'Notification UUID' })
  async action(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotificationActionDto,
  ): Promise<unknown> {
    return this.service.handleAction(id, user.userId, user.organizationId, dto);
  }
}
