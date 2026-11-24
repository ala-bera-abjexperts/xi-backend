import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class MovePageDto {
  @ApiProperty({
    description:
      'New path_name for the page (e.g. "pricing/monthly"). Cannot move the landing page.',
  })
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$/, {
    message: 'newPath must be lowercase alphanumeric with hyphens or slashes',
  })
  newPath!: string;
}
