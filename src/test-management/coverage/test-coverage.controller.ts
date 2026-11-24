import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { CoverageQueryDto } from '../dto/test-coverage.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestCoverageService } from './test-coverage.service';

/** `:spaceId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestCoverageController {
  constructor(private readonly coverage: TestCoverageService) {}

  @Get('coverage')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Requirement coverage of the space or a plan; tickets the caller cannot see are restricted',
  })
  getCoverage(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: CoverageQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.coverage.coverage(user, spaceId, query);
  }
}
