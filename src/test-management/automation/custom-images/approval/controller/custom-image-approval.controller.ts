import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

import { CurrentUser } from '../../../../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../../../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../../../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../../../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import { cleanText } from '../../../../dto/test-case.dto';
import { TestManagementResponseInterceptor } from '../../../../test-management-response.interceptor';
import { CustomImageApprovalService } from '../service/custom-image-approval.service';

// Plain text without invisible control characters, and no spaces around it.
const cleanReason = ({ value }: { value: unknown }) => {
  const cleaned = cleanText({ value });

  return typeof cleaned === 'string' ? cleaned.trim() : cleaned;
};

export class DecideCustomImageApprovalDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @ApiPropertyOptional({
    description: 'Why it is rejected; needed to reject, 3 to 500 characters',
  })
  @IsOptional()
  @Transform(cleanReason)
  @IsString()
  @Length(3, 500)
  reason?: string;
}

/** Approval of a custom image in one space. Rights are checked by the service: only this space's owners and admins decide. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/automation')
export class CustomImageApprovalController {
  constructor(private readonly approvals: CustomImageApprovalService) {}

  @Get('custom-images/:imageId/approval')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: "This space's approval of a custom test image",
  })
  state(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.approvals.state(user, spaceId, imageId);
  }

  @Post('custom-images/:imageId/approval/decide')
  @RequireSpacePermission('view_tests')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Approve or reject a custom test image for this space',
  })
  decide(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: DecideCustomImageApprovalDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.approvals.decide(
      user,
      spaceId,
      imageId,
      dto.decision,
      dto.reason,
    );
  }

  @Post('custom-images/:imageId/approval/remind')
  @RequireSpacePermission('view_tests')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Send the approval request to this space's owners and admins again",
  })
  remind(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.approvals.remind(user, spaceId, imageId);
  }
}
