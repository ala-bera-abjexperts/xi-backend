/**
 * @fileoverview DTO for performing an action on a notification (accept/decline invitation).
 * @module src/notifications/dto/notification-action.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const NOTIFICATION_ACTIONS = ['accept', 'decline'] as const;

export class NotificationActionDto {
  @ApiProperty({ enum: NOTIFICATION_ACTIONS, description: 'Action to perform' })
  @IsIn(NOTIFICATION_ACTIONS)
  action!: 'accept' | 'decline';
}
