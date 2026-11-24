import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min, ValidateIf } from 'class-validator';

export class MovePlanItemDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiProperty({
    description: 'New parent item ID; pass null to move to root level',
    nullable: true,
  })
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  new_parent_id!: string | null;

  @ApiPropertyOptional({ description: 'New sort order position', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
