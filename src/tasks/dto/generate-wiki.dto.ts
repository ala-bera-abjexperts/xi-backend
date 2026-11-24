import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class GenerateWikiDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  include_description?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_comments?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_history?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_subtasks?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_custom_fields?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_attachments?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  include_relationships?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  parent_page_id?: string | null;
}
