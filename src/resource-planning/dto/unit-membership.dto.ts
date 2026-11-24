import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateUnitMembershipDto {
  @ApiProperty()
  @IsUUID()
  unit_id!: string;

  @ApiProperty()
  @IsUUID()
  user_id!: string;

  @ApiProperty({ format: 'date' })
  @IsDateString()
  effective_from!: string;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  effective_to?: string | null;

  /**
   * Resource Planning 2.0. Share of the user's capacity this membership
   * represents when they belong to more than one team at once. Null (the
   * default) means 100% — every single-team membership can omit this.
   */
  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    exclusiveMinimum: true,
    maximum: 100,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  allocation_percent?: number | null;
}

export class UpdateUnitMembershipDto extends PartialType(
  CreateUnitMembershipDto,
) {}
