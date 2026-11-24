import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

export class AddDomainDto {
  @ApiProperty({
    description: 'Fully-qualified domain name, e.g. shop.example.com',
  })
  @IsString()
  @MaxLength(255)
  @Matches(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, {
    message: 'Invalid domain format',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : (value as string),
  )
  domain!: string;
}
