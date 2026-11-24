import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// 1 to 20 uuids, comma separated
const UUID_LIST = /^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,19}$/i;

// 1 to 20 short names or ids, comma separated
const NAME_LIST = /^[^,]{1,100}(,[^,]{1,100}){0,19}$/;

/** One page of a space's tickets that are not linked to the calendar yet. */
export class ListLinkableTicketsDto {
  @ApiPropertyOptional({
    description: 'Spaces to read, comma separated (1-20)',
  })
  @Matches(UUID_LIST, { message: 'space_ids must be 1 to 20 space ids' })
  space_ids!: string;

  @ApiPropertyOptional({ description: 'Search on key or summary' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

/** One page of the tickets linked to a calendar, with the list's search and filters. */
export class ListTicketLinksDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Search on key or summary' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Only this space' })
  @IsOptional()
  @IsUUID()
  space?: string;

  @ApiPropertyOptional({ description: 'Status names, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  status?: string;

  @ApiPropertyOptional({ description: 'Priority names, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  priority?: string;

  @ApiPropertyOptional({ description: 'Task type ids, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  type?: string;
}
