import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../auth/decorators/public.decorator';
import {
  AuthenticateTestManagementApiKeyDto,
  TestManagementAccessTokenResponse,
} from '../dto/test-management-api-key.dto';
import { TestManagementApiKeysService } from './test-management-api-keys.service';

/** Public by design: the key's id and the key itself are the credentials. */
@ApiTags('test-management')
@ApiExtraModels(TestManagementAccessTokenResponse)
@Controller('test-management/authenticate')
export class TestManagementAuthenticateController {
  constructor(private readonly service: TestManagementApiKeysService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Exchange an API key id (client_id) and the key (client_secret) for a token valid for one hour',
  })
  @ApiOkResponse({
    description:
      'The token sits under data, inside the usual { statusCode, hasError, data, message } wrapper',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 200 },
        hasError: { type: 'boolean', example: false },
        data: { $ref: getSchemaPath(TestManagementAccessTokenResponse) },
        message: { type: 'string', example: 'success' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'INVALID_CLIENT: unknown id, wrong key or expired key (the same answer for each)',
  })
  @ApiServiceUnavailableResponse({
    description:
      'TOKENS_NOT_CONFIGURED: access tokens are not set up on this server; TOKEN_NOT_SAVED: the token could not be stored',
  })
  @ApiTooManyRequestsResponse({
    description: 'More than 10 requests a minute',
  })
  authenticate(@Body() dto: AuthenticateTestManagementApiKeyDto) {
    return this.service.authenticate(dto);
  }
}
