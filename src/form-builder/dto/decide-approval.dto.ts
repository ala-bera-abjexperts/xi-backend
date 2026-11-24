import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// An approver's verdict on one approval step. The global ValidationPipe runs
// whitelist + forbidNonWhitelisted, so a client can only send decision + comment.
export class DecideApprovalDto {
  @ApiProperty({ enum: APPROVAL_DECISIONS })
  @IsIn(APPROVAL_DECISIONS as unknown as string[])
  decision!: ApprovalDecision;

  @ApiPropertyOptional({
    description: 'Reviewer note (required on reject when the form enforces it)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
