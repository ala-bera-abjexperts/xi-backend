/**
 * @fileoverview DTOs for customer-portal status transitions (contract §7). The funnel /
 * page / element triple names the STORED published `supportTicketList` block whose
 * `allowedStatusIds` authorize the transition — the caller never supplies a status list.
 * @module src/help-center/dto/support-request-transition.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class SupportRequestTransitionsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  funnelId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  pageId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  elementId!: string;
}

export class ExecuteSupportRequestTransitionDto extends SupportRequestTransitionsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  transitionId!: string;

  @ApiPropertyOptional({ description: 'Task version for optimistic locking' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
