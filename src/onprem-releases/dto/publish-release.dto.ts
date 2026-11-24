import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublishReleaseDto {
  @ApiProperty({
    example: '1.2.3',
    description: 'SemVer release version (X.Y.Z)',
  })
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/, {
    message: 'version must be a semver string like 1.2.3',
  })
  version: string;

  @ApiPropertyOptional({
    example: 'Storage bucket bootstrap + in-product updater.',
  })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ example: 'stable' })
  @IsOptional()
  @IsString()
  channel?: string;
}
