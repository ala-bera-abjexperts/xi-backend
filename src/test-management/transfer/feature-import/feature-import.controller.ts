import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AllowTestManagementApiKey } from '../../../auth/decorators/allow-test-management-api-key.decorator';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import {
  FeatureImportOptionsDto,
  TEST_TRANSFER_LIMITS,
} from '../../dto/test-transfer.dto';
import { TestManagementResponseInterceptor } from '../../test-management-response.interceptor';
import { FeatureImportService } from './feature-import.service';
import { fileError } from '../shared/transfer-helpers';

const FEATURE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

const featureUpload = () =>
  FileInterceptor('file', {
    limits: {
      fileSize: TEST_TRANSFER_LIMITS.featureUploadBytes,
      files: 1,
      fields: 5,
      fieldSize: 1024,
    },
  });

function requireFile(
  file: Express.Multer.File | undefined,
): Express.Multer.File {
  if (!file) throw fileError('Choose a .feature or .zip file to upload');

  return file;
}

/** Cucumber `.feature` or `.zip` upload; `:spaceId`, never `:id` (SpacePermissionsGuard). */
@RequireFeature('module_test_management')
@AllowTestManagementApiKey()
@ApiTags('test-management')
@ApiBearerAuth()
@ApiBearerAuth('tm-api-key')
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/import/features')
export class FeatureImportController {
  constructor(private readonly features: FeatureImportService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('create_tests')
  @Throttle(FEATURE_THROTTLE)
  @UseInterceptors(featureUpload())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Read Cucumber feature files and list which tests would be created or updated; writes nothing',
  })
  preview(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    // Declared so an unexpected form field is refused.
    @Body() options: FeatureImportOptionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.features.preview(user, spaceId, requireFile(file), options);
  }

  @Post('commit')
  @RequireSpacePermission('create_tests')
  @Throttle(FEATURE_THROTTLE)
  @UseInterceptors(featureUpload())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Create and update Cucumber tests from feature files, with background preconditions and requirement tags',
  })
  commit(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() options: FeatureImportOptionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.features.commit(user, spaceId, requireFile(file), options);
  }
}
