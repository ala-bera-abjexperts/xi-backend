import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  NotContains,
  ValidateIf,
} from 'class-validator';

// Mirrors test_folders_name_check; '/' is reserved as the path separator in imports.
export const TEST_FOLDER_NAME_MAX = 255;

// Starts with a letter; then letters, numbers and spaces. A "-" sits between characters with a letter right after it.
// The folder dialog checks the same pattern.
export const TEST_FOLDER_NAME_PATTERN =
  /^\p{L}\p{M}*(?:[\p{L}\p{N}\p{M} ]|(?<=[\p{L}\p{N}\p{M}])-(?=\p{L}))*$/u;

const NAME_PATTERN_MESSAGE =
  'name must start with a letter and may only contain letters, numbers and spaces; a "-" must be followed by a letter';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTestFolderDto {
  @ApiProperty({ minLength: 1, maxLength: TEST_FOLDER_NAME_MAX })
  @Transform(trim)
  @IsString()
  @Length(1, TEST_FOLDER_NAME_MAX)
  @NotContains('/')
  @Matches(TEST_FOLDER_NAME_PATTERN, { message: NAME_PATTERN_MESSAGE })
  name: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Parent folder; omit or null for a root folder',
  })
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;
}

/** Rename and/or move. An absent parent_id keeps the current parent; null moves to the root. */
export class UpdateTestFolderDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: TEST_FOLDER_NAME_MAX })
  @ValidateIf((dto: UpdateTestFolderDto) => dto.name !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_FOLDER_NAME_MAX)
  @NotContains('/')
  @Matches(TEST_FOLDER_NAME_PATTERN, { message: NAME_PATTERN_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Every folder under the (new) parent, this one included, in the order set by drag and drop',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  sibling_order?: string[];
}

export interface TestFolder {
  id: string;
  parent_id: string | null;
  name: string;
  case_count: number;

  // Active test sets and test plans directly in the folder, like case_count.
  set_count: number;
  plan_count: number;

  // Active test executions directly in the folder; 0 until executions have folders in this database.
  execution_count: number;

  // Place among its sister folders set by drag and drop; null keeps the name order after the placed ones.
  position: number | null;
  created_at: string;
  updated_at: string;
}
