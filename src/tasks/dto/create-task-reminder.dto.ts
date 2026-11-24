import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTaskReminderDto {
  @ApiProperty({ description: 'ISO 8601 datetime; must be in the future' })
  @IsDateString()
  remind_at!: string;

  @ApiPropertyOptional({ enum: ['email', 'in_app', 'both'], default: 'email' })
  @IsOptional()
  @IsIn(['email', 'in_app', 'both'])
  reminder_type?: 'email' | 'in_app' | 'both';

  @ApiPropertyOptional({
    description: 'Optional reminder message',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;
}
