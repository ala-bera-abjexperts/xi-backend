import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLetterDto {
  @ApiProperty()
  @IsUUID()
  plan_id!: string;

  @ApiProperty({ example: '2026-05-01' })
  @IsDateString()
  reporting_period_start!: string;

  @ApiProperty({ example: '2026-05-31' })
  @IsDateString()
  reporting_period_end!: string;

  @ApiPropertyOptional({ example: '2026-06-07' })
  @IsOptional()
  @IsDateString()
  due_date?: string | null;

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_schedule?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_budget?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  rag_quality?: 'green' | 'amber' | 'red' | null;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MinLength(0)
  @MaxLength(5000)
  key_message?: string | null;

  @ApiPropertyOptional({
    description:
      'Explicit assignee for this letter. Falls back to plan owner when omitted.',
  })
  @IsOptional()
  @IsUUID()
  assigned_to_user_id?: string | null;
}
