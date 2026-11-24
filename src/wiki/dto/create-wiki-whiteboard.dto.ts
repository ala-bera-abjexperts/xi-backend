import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

import { WhiteboardNameDto } from '../../whiteboards/dto/whiteboard-name.dto';

/** A whiteboard created from the wiki sidebar: the board's name rules, plus where its tree row goes. */
export class CreateWikiWhiteboardDto extends WhiteboardNameDto {
  @ApiPropertyOptional({ description: 'Parent page UUID (root when omitted)' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;
}
