import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DuplicateDocumentTemplateDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Name for the copy. Defaults to "<name> (Copy)".',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
