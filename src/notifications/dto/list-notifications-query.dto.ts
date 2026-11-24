/**
 * @fileoverview DTO for querying/filtering user notifications.
 * @module src/notifications/dto/list-notifications-query.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    description: 'Max notifications to return (1–100, default 50)',
    default: 50,
  })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description: 'Number of records to skip (default 0)',
    default: 0,
  })
  @IsOptional()
  @IsString()
  offset?: string;

  @ApiPropertyOptional({
    description: 'Return only unread notifications when "true"',
  })
  @IsOptional()
  @IsString()
  unread_only?: string;

  @ApiPropertyOptional({
    description:
      'ISO timestamp — return only notifications created after this time (used by the polling fallback)',
  })
  @IsOptional()
  @IsString()
  since?: string;
}
