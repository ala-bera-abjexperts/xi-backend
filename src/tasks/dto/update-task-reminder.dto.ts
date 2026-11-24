import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateTaskReminderDto {
  @ApiPropertyOptional({
    description: 'ISO 8601 datetime; must be in the future',
  })
  @IsOptional()
  @IsDateString()
  remind_at?: string;

  @ApiPropertyOptional({ enum: ['email', 'in_app', 'both'] })
  @IsOptional()
  @IsIn(['email', 'in_app', 'both'])
  reminder_type?: 'email' | 'in_app' | 'both';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_sent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  sent_at?: string | null;
}
