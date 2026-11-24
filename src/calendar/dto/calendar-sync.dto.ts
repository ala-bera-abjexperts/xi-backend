import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/** Points a calendar at one external calendar of a connected account. */
export class LinkCalendarSyncDto {
  @ApiProperty({ description: 'A calendar account this person connected' })
  @IsUUID()
  account_id!: string;

  @ApiProperty({
    description: 'Which calendar at the provider',
    maxLength: 512,
  })
  @IsString()
  @MaxLength(512)
  external_calendar_id!: string;

  @ApiPropertyOptional({
    enum: ['import', 'export', 'two_way'],
    description: 'Import brings changes in only; two_way also sends ours out',
    default: 'two_way',
  })
  @IsOptional()
  @IsIn(['import', 'export', 'two_way'])
  direction?: string;
}

/** Connects a published calendar (Apple and friends) by its link; there is nothing to sign in to. */
export class ConnectIcsDto {
  @ApiProperty({
    description: 'The published calendar link, https:// or webcal://',
    maxLength: 2048,
  })
  @IsString()
  @MaxLength(2048)
  @Matches(/^(https?|webcal):\/\//i, {
    message: 'A calendar link must start with https:// or webcal://',
  })
  url!: string;

  @ApiPropertyOptional({ description: 'What to call it', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
