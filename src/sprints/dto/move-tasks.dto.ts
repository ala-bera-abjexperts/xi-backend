import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize, IsOptional } from 'class-validator';

export class MoveTasksDto {
  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  task_ids!: string[];

  @ApiPropertyOptional({
    description: 'UUID of target sprint, or null to move to backlog',
    nullable: true,
  })
  @IsOptional()
  @IsUUID('4')
  target_sprint_id!: string | null;
}
