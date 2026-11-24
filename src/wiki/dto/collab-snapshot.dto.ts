/**
 * @fileoverview DTOs for the wiki realtime-collaboration snapshot endpoints
 * (`POST /spaces/:spaceId/wiki/:pageId/collab/snapshot` and `/heartbeat`).
 * @module src/wiki/dto/collab-snapshot.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// ~14 MB of binary ydoc state → ~19 MB as base64.
const MAX_YDOC_BASE64_CHARS = 20_000_000;

export class SaveCollabSnapshotDto {
  @ApiProperty({ description: 'Collab session UUID (owner of the snapshot)' })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({
    description:
      'Expected current snapshot seq (CAS token). The save wins only if the ' +
      'row still carries this seq; the stored seq becomes seq+1.',
  })
  @IsInt()
  @Min(0)
  seq!: number;

  @ApiProperty({
    description: 'Full Yjs document state, base64-encoded (max ~14 MB binary)',
  })
  @IsString()
  @MaxLength(MAX_YDOC_BASE64_CHARS)
  ydocState!: string;

  @ApiPropertyOptional({ description: 'Yjs state vector, base64-encoded' })
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  stateVector?: string;

  @ApiProperty({
    description:
      'Stringified TipTap JSON matching the ydoc state; sanitized and ' +
      'persisted to wiki_pages.content.',
    maxLength: 5_000_000,
  })
  @IsString()
  @MaxLength(5_000_000)
  content!: string;

  @ApiPropertyOptional({
    description:
      'Client-computed plain text (hint only; the server recomputes ' +
      'content_text authoritatively).',
    maxLength: 1_000_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1_000_000)
  contentText?: string;

  @ApiPropertyOptional({
    description:
      'Seed mode: create the snapshot row iff none exists (409 SEED_CONFLICT ' +
      'when one does).',
  })
  @IsOptional()
  @IsBoolean()
  seed?: boolean;

  @ApiPropertyOptional({
    description:
      'End the session after saving: clears active_session_id and bumps the ' +
      'page version hint so the trigger cuts a session-end version.',
  })
  @IsOptional()
  @IsBoolean()
  endSession?: boolean;
}

export class CollabHeartbeatDto {
  @ApiProperty({ description: 'Collab session UUID to keep alive' })
  @IsUUID()
  sessionId!: string;
}
