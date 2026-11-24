import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class CheckPermissionDto {
  @ApiPropertyOptional({ description: 'Single permission key to check' })
  @IsOptional()
  @IsString()
  permission?: string;

  @ApiPropertyOptional({ description: 'Multiple permission keys to check' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({ enum: ['all', 'any'], default: 'all' })
  @IsOptional()
  @IsIn(['all', 'any'])
  mode?: 'all' | 'any';
}
