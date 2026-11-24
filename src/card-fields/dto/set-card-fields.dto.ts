import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum CardFieldWidth {
  AUTO = 'auto',
  SMALL = 'small',
  MEDIUM = 'medium',
  FULL = 'full',
}

class CardFieldItemDto {
  @ApiProperty({
    description:
      'Custom field UUID or built-in identifier (e.g. __status, __priority)',
    example: '__status',
  })
  @IsString()
  @MinLength(1)
  custom_field_id!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  position!: number;

  @ApiProperty({ enum: CardFieldWidth, default: CardFieldWidth.AUTO })
  @IsOptional()
  @IsEnum(CardFieldWidth)
  width?: CardFieldWidth;

  @ApiProperty({ nullable: true, required: false })
  @IsOptional()
  @IsString()
  color?: string | null;
}

export class SetCardFieldsDto {
  @ApiProperty({ type: [CardFieldItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CardFieldItemDto)
  fields!: CardFieldItemDto[];
}
