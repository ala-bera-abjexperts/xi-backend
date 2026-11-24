import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum CompleteSprintAction {
  MOVE_TO_SPRINT = 'move_to_sprint',
  MOVE_TO_BACKLOG = 'move_to_backlog',
}

export class CompleteSprintDto {
  @ApiPropertyOptional({
    description:
      'Legacy sprint UUID echoed by Next clients (ignored; path param is authoritative)',
  })
  @IsOptional()
  @IsUUID('4')
  sprint_id?: string;

  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiProperty({ enum: CompleteSprintAction })
  @IsEnum(CompleteSprintAction)
  action!: CompleteSprintAction;

  @ApiPropertyOptional({
    description: 'Required when action is move_to_sprint',
  })
  @IsOptional()
  @IsUUID('4')
  target_sprint_id?: string;
}
