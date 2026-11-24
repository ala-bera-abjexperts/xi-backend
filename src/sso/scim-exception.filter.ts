/**
 * @fileoverview Controller-scoped exception filter that renders every error on
 * the SCIM routes as an RFC 7644 error document (`application/scim+json`).
 * @module src/sso/scim-exception.filter
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SCIM_ERROR_SCHEMA } from './scim.util';

/**
 * Maps any exception to `{schemas, status, scimType?, detail}`. Server errors
 * are logged and rendered with a generic detail, so internals never leak.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  /** @private Logger instance scoped to this filter */
  private readonly logger = new Logger(ScimExceptionFilter.name);

  /**
   * @param {unknown} exception - The caught exception
   * @param {ArgumentsHost} host - Access to the HTTP response
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (response.headersSent) return;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'Internal server error';
    let scimType: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        detail = body;
      } else {
        const { message, scimType: type } = body as {
          message?: unknown;
          scimType?: unknown;
        };

        if (typeof message === 'string') detail = message;
        if (Array.isArray(message)) detail = message.join('; ');
        if (typeof type === 'string') scimType = type;
      }
    }

    if (status >= 500) {
      this.logger.error(
        'SCIM request failed',
        exception instanceof Error ? exception.stack : String(exception),
      );
      detail = 'Internal server error';
      scimType = undefined;
    }

    response
      .status(status)
      .type('application/scim+json')
      .send(
        JSON.stringify({
          schemas: [SCIM_ERROR_SCHEMA],
          status: String(status),
          ...(scimType ? { scimType } : {}),
          detail,
        }),
      );
  }
}
