/**
 * @fileoverview DTO for marking a notification as read or unread.
 * @module src/notifications/dto/mark-read.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class MarkReadDto {
  @ApiProperty({ description: 'Whether the notification is read' })
  @IsBoolean()
  is_read!: boolean;
}
