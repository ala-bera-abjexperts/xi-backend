import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class RestoreFormVersionDto {
  @ApiProperty({
    description:
      'Expected current form.version (optimistic lock). A mismatch → 409, so a concurrent edit is never silently overwritten.',
    example: 3,
  })
  @IsInt()
  @Min(1)
  version!: number;
}
