import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class StartSprintDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: '2026-04-21' })
  @IsDateString()
  start_date!: string;

  @ApiProperty({ example: '2026-05-04' })
  @IsDateString()
  end_date!: string;
}
