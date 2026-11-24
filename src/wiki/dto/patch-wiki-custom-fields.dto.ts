/**
 * @fileoverview DTO for the partial custom-field value update on a wiki page.
 *
 * Merge semantics: only the keys present in `values` are touched. An explicit
 * `null` deletes that key. This exists as a dedicated endpoint (rather than
 * reusing UpdateWikiPageDto) so that two editing surfaces — the right-rail
 * properties panel and the in-body properties block — can each send only what
 * they changed instead of racing full-map writes.
 *
 * @module src/wiki/dto/patch-wiki-custom-fields.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class PatchWikiCustomFieldsDto {
  @ApiProperty({
    description:
      'Partial map of field_key -> value. An explicit null clears that key. ' +
      'Keys absent from this map are left untouched.',
    example: { owner: 'user-uuid', review_date: null },
  })
  @IsObject()
  values!: Record<string, unknown>;
}
