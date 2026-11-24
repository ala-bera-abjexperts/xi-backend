import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';

import {
  APPROVAL_RULES,
  APPROVER_GROUPS,
  type ApprovalRule,
  type ApproverGroup,
} from '../automation/custom-images/approval/rules/approval-rules';

/** One test type of the space; its kind decides how a test is written. */
export class TestTypeDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['steps', 'gherkin', 'unstructured', 'exploratory'] })
  kind: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: Object })
  name_i18n: Record<string, string>;
}

/** A space without a settings row returns these defaults. */
export class TestManagementSettingsResponseDto {
  @ApiProperty()
  assignee_only: boolean;

  @ApiProperty({ type: [String] })
  coverable_task_type_ids: string[];

  @ApiProperty({ type: String, nullable: true })
  defect_task_type_id: string | null;

  @ApiProperty({ type: [String] })
  requirement_link_task_type_ids: string[];

  // Task type used for each test kind; null until the module is first switched on.
  @ApiPropertyOptional({ type: String, nullable: true })
  case_task_type_id?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  set_task_type_id?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  plan_task_type_id?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  execution_task_type_id?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  precondition_task_type_id?: string | null;

  @ApiPropertyOptional({ type: [TestTypeDto] })
  test_types?: TestTypeDto[];

  // Custom image approval; left out while its columns aren't there yet.
  @ApiPropertyOptional()
  image_approval_required?: boolean;

  @ApiPropertyOptional({ enum: APPROVAL_RULES })
  image_approval_rule?: ApprovalRule;

  // Left out while its column isn't there yet.
  @ApiPropertyOptional({ enum: APPROVER_GROUPS })
  image_approval_approvers?: ApproverGroup;

  // Sent while approval is on; false means nobody could approve an admin's image.
  @ApiPropertyOptional()
  image_approval_has_owners?: boolean;
}

/** Body for PUT settings; only the fields sent are changed. */
export class UpdateTestManagementSettingsDto {
  @ApiPropertyOptional({
    description: 'Only the assigned tester may record results on a run',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  assignee_only?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Ticket types counted as requirements; empty means every type except test and defect types',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  coverable_task_type_ids?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Ticket type for new defects; null clears it',
  })
  @ValidateIf(
    (_: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @Length(1, 100)
  defect_task_type_id?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Ticket types that may be linked to a test case as requirements; empty means every type',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  requirement_link_task_type_ids?: string[];

  @ApiPropertyOptional({
    description:
      'Custom Docker images need approval in this space after their security check',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  image_approval_required?: boolean;

  @ApiPropertyOptional({
    enum: APPROVAL_RULES,
    description: 'Any one approver approves, or all of them must approve',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsIn(APPROVAL_RULES)
  image_approval_rule?: ApprovalRule;

  @ApiPropertyOptional({
    enum: APPROVER_GROUPS,
    description:
      'Who approves: the space owners, or the owners and admins; an admin image always goes to the owners',
  })
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsIn(APPROVER_GROUPS)
  image_approval_approvers?: ApproverGroup;
}
