import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Optional reason recorded on a revoked MCP grant. */
export class RevokeGrantDto {
  @ApiPropertyOptional({ description: 'Why the grant is being revoked' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
