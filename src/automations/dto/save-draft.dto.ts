import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject } from 'class-validator';

export class SaveDraftDto {
  @ApiPropertyOptional({
    description: 'Trigger kind (e.g. webhook.received, schedule.cron, manual)',
  })
  @IsOptional()
  @IsString()
  trigger_kind?: string;

  @ApiPropertyOptional({ description: 'Trigger configuration object' })
  @IsOptional()
  @IsObject()
  trigger_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Workflow definition (nodes + edges in ReactFlow format)',
  })
  @IsOptional()
  @IsObject()
  definition?: {
    nodes: unknown[];
    edges: unknown[];
    variables?: Record<string, unknown>;
  };
}
