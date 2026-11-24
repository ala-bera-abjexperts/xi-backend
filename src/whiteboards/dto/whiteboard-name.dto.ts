import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/** Body for create and rename. Trimmed first, so a whitespace-only name fails `Length`. */
export class WhiteboardNameDto {
  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Sprint retro' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 200)
  name: string;
}
