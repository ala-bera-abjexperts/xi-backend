import {
  Body,
  Controller,
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
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser } from '../../../../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../../../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../../../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../../../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import { TestManagementResponseInterceptor } from '../../../../test-management-response.interceptor';
import { LABEL_VALUE } from '../../registry/custom-image-review';
import {
  optionalText,
  USER_IMAGE_LANGUAGES,
} from '../../shared/inputs/custom-image-inputs';
import { TestAutomationCustomImageUploadsService } from '../service/test-automation-custom-image-uploads.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// A plain file name, no folders or control characters, saved by docker save and maybe gzipped.
// eslint-disable-next-line no-control-regex
const IMAGE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]+\.(tar|tar\.gz|tgz)$/i;
const PLATFORM = /^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/;

export class FinishImageUploadDto {
  @ApiProperty({
    description: 'Digest of the image settings file, from manifest.json',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  config_digest!: string;

  @ApiProperty({
    description: 'Name of the uploaded file, ending in .tar, .tar.gz or .tgz',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  @Matches(IMAGE_FILE_NAME, {
    message:
      'file_name must be a file name ending in .tar, .tar.gz or .tgz, without folders',
  })
  file_name!: string;

  @ApiProperty({ description: 'Whether the file is gzipped' })
  @IsBoolean()
  gzip!: boolean;

  @ApiPropertyOptional({
    description:
      'Whether others in the organisation may use the image; on when left out',
  })
  @IsOptional()
  @IsBoolean()
  shared?: boolean;

  @ApiPropertyOptional({
    description: 'Language the user picked, for an image without labels',
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  @IsIn(USER_IMAGE_LANGUAGES)
  language?: string;

  @ApiPropertyOptional({
    description: 'Test framework the user picked, for an image without labels',
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  test_framework?: string;

  @ApiPropertyOptional({
    description: "Language label read from the file's settings",
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  image_language?: string;

  @ApiPropertyOptional({
    description: "Test framework label read from the file's settings",
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  image_test_framework?: string;
}

export class StartImageUploadDto extends FinishImageUploadDto {
  @ApiProperty({ description: 'Size of the file in bytes' })
  @IsInt()
  @Min(1)
  file_bytes!: number;

  @ApiProperty({
    description:
      'Platform of the image as read by the browser, such as linux/amd64',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  @Matches(PLATFORM)
  platform!: string;
}

/** Uploading a docker save file as a custom image; same guards and path as the other custom image routes. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/automation')
export class TestAutomationCustomImageUploadsController {
  constructor(
    private readonly uploads: TestAutomationCustomImageUploadsService,
  ) {}

  @Post('custom-images/uploads')
  @RequireSpacePermission('edit_space_settings')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Start uploading a custom test image file, or reuse the image when it is already here',
  })
  start(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: StartImageUploadDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.uploads.start(user, spaceId, dto);
  }

  @Post('custom-images/uploads/complete')
  @RequireSpacePermission('edit_space_settings')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Record an uploaded custom test image file for its check',
  })
  complete(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: FinishImageUploadDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.uploads.complete(user, spaceId, dto);
  }
}
