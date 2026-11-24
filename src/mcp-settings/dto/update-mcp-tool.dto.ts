import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Enable or disable a single MCP tool for the org's per-tool allow-list. */
export class UpdateMcpToolDto {
  @ApiProperty({ description: 'Whether this tool is allowed for the org' })
  @IsBoolean()
  enabled!: boolean;
}
