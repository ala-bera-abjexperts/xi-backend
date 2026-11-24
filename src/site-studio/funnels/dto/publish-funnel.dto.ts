import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class PublishFunnelDto {
  @ApiPropertyOptional({
    description: 'Target published state. Omit to toggle current state.',
  })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
