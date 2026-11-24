import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class AssignCustomFieldDto {
  @ApiProperty()
  @IsUUID('4')
  custom_field_id!: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 4, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  column_span?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  default_value_override?: unknown;
}
