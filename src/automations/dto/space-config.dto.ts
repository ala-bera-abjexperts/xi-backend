import { IsUUID, IsOptional, IsNumber, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class GetSpaceConfigDto {
  @ApiProperty({ description: 'Space UUID' })
  @IsUUID()
  spaceId: string;
}

export class UpdateSpaceConfigDto {
  @ApiProperty({ description: 'Space UUID' })
  @IsUUID()
  spaceId: string;

  @ApiPropertyOptional({
    description:
      'Maximum concurrent automation runs for this space. null or omitted = unlimited.',
    minimum: 1,
    maximum: 500,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Max(500)
  @Type(() => Number)
  max_concurrent_runs?: number | null;
}
