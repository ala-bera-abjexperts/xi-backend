import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateReminderDto {
  @ApiProperty({
    description: 'When to send the reminder (ISO 8601, must be in the future)',
  })
  @IsDateString()
  remind_at!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @ApiPropertyOptional({ enum: ['email', 'in_app', 'both'], default: 'in_app' })
  @IsOptional()
  @IsIn(['email', 'in_app', 'both'])
  reminder_type?: 'email' | 'in_app' | 'both';
}
