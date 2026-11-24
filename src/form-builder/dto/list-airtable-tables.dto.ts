import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the Airtable table picker. baseId identifies which base to list tables for;
// the credential is optional so editing an existing integration can reuse the stored PAT.
export class ListAirtableTablesDto {
  @ApiProperty({
    description:
      'Airtable base ID (e.g. appXXXXXXXXXXXXXX) to list tables for.',
  })
  @IsString()
  @MaxLength(100)
  baseId!: string;

  @ApiPropertyOptional({
    description:
      'Airtable Personal Access Token. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
