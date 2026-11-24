import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class GeneratePlanDto {
  @ApiProperty({
    description:
      'Natural language prompt describing the project plan (10-50000 chars)',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(50000)
  prompt!: string;
}
