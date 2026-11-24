import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export enum FeNodeTypeFilter {
  FILE = 'file',
  FOLDER = 'folder',
}

export class ListNodesQueryDto {
  @ApiPropertyOptional({
    enum: [
      'all',
      'starred',
      'recent',
      'shared-with-me',
      'shared-from-me',
      'trash',
    ],
    default: 'all',
  })
  @IsOptional()
  @IsIn([
    'all',
    'starred',
    'recent',
    'shared-with-me',
    'shared-from-me',
    'trash',
  ])
  view?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({ description: 'Parent folder ID. Omit for root.' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({
    description:
      'Folder ID whose ENTIRE SUBTREE (any depth) is listed. Distinct from parent_id, which is direct children only.',
  })
  @IsOptional()
  @IsUUID()
  folder_id?: string;

  @ApiPropertyOptional({
    description:
      'Label IDs (repeat the param or pass one comma-separated value). Matches nodes carrying ANY of them.',
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  label_ids?: string[];

  @ApiPropertyOptional({ enum: FeNodeTypeFilter })
  @IsOptional()
  @IsEnum(FeNodeTypeFilter)
  type?: FeNodeTypeFilter;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Return only starred nodes for current user',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  starred?: boolean;
}
