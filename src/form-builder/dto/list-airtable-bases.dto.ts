import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the Airtable base picker. The credential is optional: when editing an existing
// integration the dialog leaves it blank and the server falls back to the stored PAT.
export class ListAirtableBasesDto {
  @ApiPropertyOptional({
    description:
      'Airtable Personal Access Token to list bases with. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
