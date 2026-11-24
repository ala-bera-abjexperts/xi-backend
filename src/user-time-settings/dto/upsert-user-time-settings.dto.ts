import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, Matches } from 'class-validator';

export class UpsertUserTimeSettingsDto {
  @ApiProperty()
  @IsBoolean()
  reminder_enabled!: boolean;

  @ApiProperty({ description: 'HH:mm format', example: '09:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'reminder_time must be HH:mm format' })
  reminder_time!: string;
}
