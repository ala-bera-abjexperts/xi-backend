import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class CreateLinkDto {
  @ApiProperty({ enum: ['asset_item', 'task', 'process'] })
  @IsIn(['asset_item', 'task', 'process'])
  target_type!: 'asset_item' | 'task' | 'process';

  @ApiProperty()
  @IsUUID('4')
  target_id!: string;

  @ApiPropertyOptional({
    enum: ['related', 'blocks', 'blocked_by', 'duplicates', 'parent', 'child'],
    default: 'related',
  })
  @IsOptional()
  @IsIn(['related', 'blocks', 'blocked_by', 'duplicates', 'parent', 'child'])
  link_type?: string;
}
