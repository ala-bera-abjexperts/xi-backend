import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateSavedViewDto {
  @ApiProperty()
  @IsUUID()
  portfolio_id!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description:
      'Opaque view-state blob (column visibility, filters, sort, etc.). Stored as JSONB.',
    example: { columns: ['name', 'rag'], sort: 'name:asc' },
  })
  @IsObject()
  view_state!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Mark this view as the default for this user + portfolio.',
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
