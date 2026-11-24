import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { CLIENT_SUBMISSION_SURFACES } from '../submission-surface.util';
import type { ClientSubmissionSurface } from '../submission-surface.util';

export class CreateFormBuilderSubmissionDto {
  @ApiProperty({
    description: 'Answer map keyed by field_key (e.g. { field_123: "Ada" }).',
  })
  @IsObject()
  data: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Marks a preview submission from the builder — bypasses the published-status gate and is excluded from response counts.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  is_test?: boolean;

  @ApiPropertyOptional({
    description:
      'Links the response to an existing task (inline form on a task detail). Suppresses the form -> task creator; the task must be in the same space and organization.',
  })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiPropertyOptional({
    description:
      "Where the form was filled. Absent = the form's own page. A surface whose ticket switch is off creates no ticket.",
    enum: CLIENT_SUBMISSION_SURFACES,
  })
  @IsOptional()
  @IsIn(CLIENT_SUBMISSION_SURFACES)
  surface?: ClientSubmissionSurface;
}
