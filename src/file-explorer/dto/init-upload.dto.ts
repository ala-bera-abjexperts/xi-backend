import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for `POST files/upload-init` — begins a direct-to-storage upload.
 *
 * The client sends metadata only; the bytes go straight from the browser to Supabase via the
 * returned signed URL. `size` is what the client CLAIMS it will upload and is used for the
 * up-front quota check only — it is re-verified against the real object at completion, so a
 * dishonest value cannot get a file past quota.
 */
export class InitUploadDto {
  @ApiProperty({ description: 'File name, as it will appear in the tree' })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description: 'Declared size in bytes; verified on completion',
  })
  @IsInt()
  @Min(0)
  size!: number;

  @ApiPropertyOptional({ description: 'Parent folder ID. Omit for root.' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({ description: 'MIME type reported by the client' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  mime_type?: string;

  @ApiPropertyOptional({ description: 'Version comment' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/**
 * Body for `POST files/:id/versions/upload-init` — a new version of an existing file. The name and
 * parent are already fixed by the node, so only the payload metadata is needed.
 */
export class InitVersionUploadDto {
  @ApiProperty({
    description: 'Declared size in bytes; verified on completion',
  })
  @IsInt()
  @Min(0)
  size!: number;

  @ApiPropertyOptional({
    description: 'File name, used only for the storage key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'MIME type reported by the client' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  mime_type?: string;

  @ApiPropertyOptional({ description: 'Version comment' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Body for `POST files/:id/upload-complete` — confirms the bytes landed. */
export class CompleteUploadDto {
  @ApiProperty({ description: 'Version ID returned by upload-init' })
  @IsUUID()
  version_id!: string;
}
