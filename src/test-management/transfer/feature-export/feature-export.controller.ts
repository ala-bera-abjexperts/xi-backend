import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { AllowTestManagementApiKey } from '../../../auth/decorators/allow-test-management-api-key.decorator';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { contentDispositionAttachment } from '../../../common/content-disposition';
import { FeatureExportQueryDto } from '../../dto/test-transfer.dto';
import { TestManagementResponseInterceptor } from '../../test-management-response.interceptor';
import { FeatureExportService } from './feature-export.service';

/** `:spaceId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@AllowTestManagementApiKey()
@ApiTags('test-management')
@ApiBearerAuth()
@ApiBearerAuth('tm-api-key')
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/export/features')
export class FeatureExportController {
  constructor(private readonly features: FeatureExportService) {}

  @Get()
  @RequireSpacePermission('view_tests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Cucumber tests as a ZIP of .feature files (at most 10,000 cases); tests that cannot be written are listed in skipped.txt',
  })
  async exportFeatures(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: FeatureExportQueryDto,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    // Built in full before any header is sent, so a failure is a normal error response.
    const { fileName, buffer } = await this.features.export(
      user,
      spaceId,
      query,
    );

    res.status(HttpStatus.OK);
    res.set({
      'Content-Type': 'application/zip',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDispositionAttachment(fileName),
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }
}
