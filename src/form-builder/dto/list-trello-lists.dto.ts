import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Body for the Trello list picker. Trello auth = API key (config) + token (credential): the key is
// required to fetch, while the token is optional so editing an existing integration can fall back to
// the stored one.
export class ListTrelloListsDto {
  @ApiProperty({
    description: 'Trello API key used to list the boards’ Lists.',
  })
  @IsString()
  @MaxLength(2000)
  apiKey!: string;

  @ApiPropertyOptional({
    description:
      'Trello token to list Lists with. Omit to reuse the stored credential.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  credential?: string;
}
