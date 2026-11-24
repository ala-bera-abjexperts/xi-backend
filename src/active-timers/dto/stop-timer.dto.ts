import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class StopTimerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    description: 'Legacy body value ignored; org is derived from auth context',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
