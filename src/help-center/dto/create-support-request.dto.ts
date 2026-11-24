import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum SupportRequestCategory {
  TECHNICAL = 'technical',
  FEATURE_REQUEST = 'feature_request',
  BUG = 'bug',
  GENERAL = 'general',
}

export enum SupportRequestPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum SupportRequestStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export class CreateSupportRequestDto {
  @ApiProperty({ description: 'Short title of the issue' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  subject!: string;

  @ApiProperty({ enum: SupportRequestCategory })
  @IsEnum(SupportRequestCategory)
  category!: SupportRequestCategory;

  /**
   * Legacy four-value priority. Still accepted (older callers and the dashboard form send
   * only this); the service buckets it. Prefer `priority_id` for a configurable priority.
   */
  @ApiPropertyOptional({
    enum: SupportRequestPriority,
    description:
      'Legacy priority key (low|medium|high|critical). Prefer priority_id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  priority?: string;

  /**
   * Org/space-configurable priority from `task_priorities`. When present it is the source of
   * truth and `priority` is ignored (the legacy bucket is derived from it).
   */
  @ApiPropertyOptional({
    description: 'Configurable priority UUID (from /task-priorities)',
  })
  @IsOptional()
  @IsUUID()
  priority_id?: string;

  @ApiProperty({
    description: 'Full description of the issue (10–10 000 chars)',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(10000)
  description!: string;

  @ApiPropertyOptional({
    description: 'XiSuite module key affected (e.g. tasks, boards)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  module_affected?: string;

  @ApiPropertyOptional({ description: 'Space UUID this ticket belongs to' })
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional({
    enum: SupportRequestStatus,
    default: SupportRequestStatus.OPEN,
  })
  @IsOptional()
  @IsEnum(SupportRequestStatus)
  status?: SupportRequestStatus;

  @ApiPropertyOptional({
    description:
      'Human-readable request type label configured in the form builder',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  request_type?: string;

  @ApiPropertyOptional({
    description: 'Custom field answers keyed by custom_fields.field_key',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;
}
