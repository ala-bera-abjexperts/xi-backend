import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export enum OrganizationUnitType {
  UNIT = 'unit',
  TEAM = 'team',
}

export class CreateOrganizationUnitDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/\S/)
  name!: string;

  @ApiPropertyOptional({ enum: OrganizationUnitType, default: 'unit' })
  @IsOptional()
  @IsEnum(OrganizationUnitType)
  unit_type?: OrganizationUnitType;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parent_id?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string | null;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateOrganizationUnitDto extends PartialType(
  CreateOrganizationUnitDto,
) {}
