import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  Max,
  Min,
} from 'class-validator';

import { WHITEBOARD_MAX_ELEMENTS } from '../whiteboards.constants';

/**
 * One autosave. `elements` is the full Excalidraw element list INCLUDING `isDeleted`
 * tombstones (the client's getSceneElementsIncludingDeleted()), so a stale save can be
 * merged with reconcileElements instead of resurrecting shapes someone else deleted.
 * The service validates each element's shape and whitelists `app_state`.
 */
export class SaveWhiteboardSceneDto {
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  @ArrayMaxSize(WHITEBOARD_MAX_ELEMENTS)
  @IsObject({ each: true })
  elements: Record<string, unknown>[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  app_state: Record<string, unknown>;

  @ApiProperty({
    description: 'The revision this scene was based on (optimistic lock)',
  })
  @IsInt()
  @Min(0)
  @Max(2_000_000_000) // base_revision + 1 must still fit the int column
  base_revision: number;
}
