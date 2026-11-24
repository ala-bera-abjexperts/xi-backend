import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateWorkloadSchemeDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/\S/)
  name!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ default: 8, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  monday_hours?: number;

  @ApiPropertyOptional({ default: 8, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  tuesday_hours?: number;

  @ApiPropertyOptional({ default: 8, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  wednesday_hours?: number;

  @ApiPropertyOptional({ default: 8, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  thursday_hours?: number;

  @ApiPropertyOptional({ default: 8, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  friday_hours?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  saturday_hours?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  sunday_hours?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateWorkloadSchemeDto extends PartialType(
  CreateWorkloadSchemeDto,
) {}
