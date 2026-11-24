import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, Min } from 'class-validator';

export class UpdateCustomFieldValuesDto {
  @ApiProperty({ type: Object })
  @IsObject()
  customFieldValues!: Record<string, unknown>;

  @ApiProperty({ description: 'Current item version for optimistic locking' })
  @IsInt()
  @Min(1)
  version!: number;
}
