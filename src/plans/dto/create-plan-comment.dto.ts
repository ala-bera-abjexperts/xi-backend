import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePlanCommentDto {
  @ApiProperty({
    description: 'Comment content — supports HTML (max 10000 chars)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content!: string;
}
