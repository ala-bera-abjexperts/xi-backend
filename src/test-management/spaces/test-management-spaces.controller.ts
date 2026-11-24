import { Controller, Get, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AllowTestManagementApiKey } from '../../auth/decorators/allow-test-management-api-key.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestManagementSpacesService } from './test-management-spaces.service';

/** Organization-level list for the sidebar entry; each space is still checked for view_tests. */
@RequireFeature('module_test_management')
@AllowTestManagementApiKey()
@ApiTags('test-management')
@ApiBearerAuth()
@ApiBearerAuth('tm-api-key')
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('test-management/spaces')
export class TestManagementSpacesController {
  constructor(private readonly service: TestManagementSpacesService) {}

  @Get()
  @ApiOperation({
    summary: 'Spaces where the caller can use Test Management',
  })
  @ApiOkResponse({ description: 'id, key and name of each space' })
  list(@CurrentUser() user: RequestUser) {
    return this.service.listForUser(user);
  }
}
