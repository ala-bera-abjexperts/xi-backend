import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAssetObjectTypeDto {
  @ApiProperty({ description: 'Schema this type belongs to' })
  @IsUUID('4')
  schema_id!: string;

  @ApiPropertyOptional({
    description: 'Parent type UUID — omit for a root type',
  })
  @IsOptional()
  @IsUUID('4')
  parent_object_type_id?: string;

  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Iconify ref, e.g. lucide:server',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  text_color?: string;

  @ApiPropertyOptional({
    description: 'Abstract types hold no object instances',
  })
  @IsOptional()
  @IsBoolean()
  is_abstract?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Field group UUIDs to attach to this type',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  field_group_ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
