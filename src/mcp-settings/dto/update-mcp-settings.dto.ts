import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Master MCP toggles for an organization. Both fields optional so the UI can
 * PATCH just the one that changed; at least one should be present.
 */
export class UpdateMcpSettingsDto {
  @ApiPropertyOptional({ description: 'Whether MCP is enabled for the org' })
  @IsOptional()
  @IsBoolean()
  is_enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Whether MCP write tools are allowed (master gate for writes)',
  })
  @IsOptional()
  @IsBoolean()
  allow_write_tools?: boolean;
}
