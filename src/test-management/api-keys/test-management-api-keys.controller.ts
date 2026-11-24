import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireRoles } from '../../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../../auth/guards/roles.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { TestAutomationCiVariablesService } from '../automation/test-automation-ci-variables.service';
import { SaveApiKeyInCiDto } from '../dto/test-automation.dto';
import {
  CreateTestManagementApiKeyDto,
  ListTestManagementApiKeysQueryDto,
} from '../dto/test-management-api-key.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestManagementApiKeysService } from './test-management-api-keys.service';

/** Self-service key routes; API keys are never accepted here, so a key cannot mint or revoke keys. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('test-management/api-keys')
export class TestManagementApiKeysController {
  constructor(
    private readonly service: TestManagementApiKeysService,
    private readonly ciVariables: TestAutomationCiVariablesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the caller’s API keys, or all with ?all=true',
  })
  @ApiOkResponse({ description: 'Keys without their secret, newest first' })
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListTestManagementApiKeysQueryDto,
  ) {
    return this.service.list(user, query.all === true);
  }

  @Post()
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create an API key; the token is shown only once' })
  @ApiCreatedResponse({ description: 'token and api_key' })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTestManagementApiKeyDto,
  ) {
    return this.service.create(user, dto);
  }

  @Get('ci-targets')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Connected GitHub and GitLab repositories and Jenkins servers a key can be saved in',
  })
  ciTargets(@CurrentUser() user: RequestUser) {
    return this.ciVariables.targets(user.organizationId, user);
  }

  @Post('ci-targets/save')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Create an API key and save it in a connected GitHub repository (as an Actions variable), GitLab project or Jenkins server',
  })
  saveInCi(@CurrentUser() user: RequestUser, @Body() dto: SaveApiKeyInCiDto) {
    return this.ciVariables.sendToTarget(user, dto);
  }

  @Delete(':keyId')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke (delete) an API key' })
  @ApiOkResponse({ description: 'id of the revoked key' })
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ) {
    return this.service.revoke(user, keyId);
  }
}
