import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';

// Created time, last edit time, commenter name and comment text, each ascending or descending
export const TASK_COMMENT_SORTS = [
  'oldest',
  'newest',
  'updated_desc',
  'updated_asc',
  'author_asc',
  'author_desc',
  'message_asc',
  'message_desc',
] as const;

export type TaskCommentSort = (typeof TASK_COMMENT_SORTS)[number];

// Orders comments with the same user name or text, applied in the order the user picked them
export const TASK_COMMENT_TIE_SORTS = [
  'oldest',
  'newest',
  'updated_desc',
  'updated_asc',
] as const;

export type TaskCommentTieSort = (typeof TASK_COMMENT_TIE_SORTS)[number];

export class SaveTaskCommentPreferencesDto {
  @ApiProperty({
    description: 'Task comment sort order',
    enum: TASK_COMMENT_SORTS,
  })
  @IsIn(TASK_COMMENT_SORTS)
  sort!: TaskCommentSort;

  @ApiPropertyOptional({
    description:
      'Orders for comments with the same user name or text, applied in sequence (one created and one updated at most)',
    enum: TASK_COMMENT_TIE_SORTS,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(TASK_COMMENT_TIE_SORTS, { each: true })
  then?: TaskCommentTieSort[];
}
