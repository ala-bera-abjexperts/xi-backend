import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBudgetCostCategoryDto {
  @ApiProperty({ maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/\S/)
  code!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/)
  label!: string;

  @ApiPropertyOptional({ enum: ['RC', 'NRC', 'OTHER'], default: 'OTHER' })
  @IsOptional()
  @IsIn(['RC', 'NRC', 'OTHER'])
  cost_group?: 'RC' | 'NRC' | 'OTHER';

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateBudgetCostCategoryDto extends PartialType(
  CreateBudgetCostCategoryDto,
) {}
