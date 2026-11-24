import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export function moduleDisabled(): ForbiddenException {
  return new ForbiddenException({
    code: 'MODULE_DISABLED',
    message: 'Test Management is not enabled in this space',
  });
}

export function spaceReadOnly(): ForbiddenException {
  return new ForbiddenException({
    code: 'SPACE_READ_ONLY',
    message: 'This space is archived or being deleted',
  });
}

/** Missing and foreign ids get the same answer, so ids of other tenants cannot be probed. */
export function notFound(data?: Record<string, unknown>): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Not found',
    ...(data && { data }),
  });
}

/** Maps a database error to the module's API error; anything unexpected is logged and hidden. */
export function tmDbError(
  logger: Logger,
  action: string,
  error: { code?: string; message: string },
): HttpException {
  switch (error.code) {
    case '23505':
      return new ConflictException({
        code: 'DUPLICATE_NAME',
        message: 'The name is already in use',
      });
    case '22001':
    case '22003':
    case '22023':
    case '22P02':
    case '22P05':
    case '23502':
    case '23514':
      return new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'The data is not valid',
      });
    // A referenced row vanished mid-request (e.g. a folder deleted concurrently).
    case '23503':
      logger.warn(`Failed to ${action} [23503]: ${error.message}`);

      return notFound();
    case '55P03':
    case '40P01':
      return new ConflictException({
        code: 'BUSY',
        message: 'The record is busy, please try again',
      });
    case '57014':
      logger.warn(`Failed to ${action} [57014]: ${error.message}`);

      return new ServiceUnavailableException({
        code: 'TIMEOUT',
        message: 'The request took too long, please try again',
      });
  }

  // TM900 (immutable column guard) stays a 500: only a code bug can trip it.
  logger.error(
    `Failed to ${action} [${error.code ?? 'no code'}]: ${error.message}`,
  );

  return new InternalServerErrorException(`Failed to ${action}`);
}

/** Shape of an error returned by a tm_* function call. */
export interface TmRpcError {
  code?: string;
  message: string;
  details?: string | null;
}

function rpcDetail(error: TmRpcError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(error.details ?? '');

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Maps the SQLSTATEs raised by the tm_* functions to API errors.
 * Messages carry a "tm: " prefix, which is stripped; the DETAIL json is passed on as `detail`.
 */
export function tmRpcError(
  logger: Logger,
  action: string,
  error: TmRpcError,
): HttpException {
  const message = error.message.replace(/^tm:\s*/, '');
  const detail = rpcDetail(error);

  switch (error.code) {
    // Bulk and membership changes list the ids they could not find; missing and foreign ids look the same.
    // A missing folder is named too, so the screen can tell it apart from a missing item.
    case 'P0002':
      return notFound(
        Array.isArray(detail.not_found)
          ? { not_found: detail.not_found }
          : typeof detail.folder_id === 'string'
            ? { folder_id: detail.folder_id }
            : undefined,
      );
    case 'TM001':
      return new ConflictException({
        code: 'REVISION_CONFLICT',
        message: 'This test case was changed by someone else. Reload it.',
        data: { current_revision: detail.current_revision },
      });
    case 'TM002':
      return new ConflictException({
        code: 'RESULT_CONFLICT',
        message: 'This result was changed by someone else. Reload it.',
        data: detail,
      });
    case 'TM003':
      return new ConflictException({
        code: 'ATTEMPT_NOT_CURRENT',
        message: 'This attempt is no longer the current one. Reload the run.',
        data: detail,
      });
    case 'TM004':
      return new ConflictException({ code: 'ARCHIVED', message });
    case 'TM005':
      return new ConflictException({
        code: 'CASE_HAS_RUNS',
        message:
          'The test case has runs and cannot be deleted. Archive it instead.',
      });
    case 'TM006':
      return new ConflictException({
        code: 'FOLDER_CYCLE',
        message:
          'A folder cannot be moved into itself or one of its sub-folders',
      });
    case 'TM007':
      return new ConflictException({
        code: 'FOLDER_NOT_EMPTY',
        message:
          'The folder still contains sub-folders, test cases, test sets or test plans',
        data: {
          subfolders: detail.subfolders,
          cases: detail.cases,
          archived_cases: detail.archived_cases ?? 0,
          sets: detail.sets ?? 0,
          archived_sets: detail.archived_sets ?? 0,
          plans: detail.plans ?? 0,
          archived_plans: detail.archived_plans ?? 0,
        },
      });
    case 'TM009':
      return new ConflictException({
        code: 'IMPORT_ALREADY_APPLIED',
        message: 'A JUnit file was already applied to this execution',
        data: detail,
      });
    case 'TM010':
      return new HttpException(
        { code: 'INVALID_REFERENCE', message, data: detail },
        422,
      );
    case 'TM011':
      return new ForbiddenException({
        code: 'NOT_ASSIGNEE',
        message: 'Only the assignee can record results for this run',
        data: detail,
      });
    case 'TM012':
      return new ConflictException({
        code: 'ATTEMPT_ABORTED',
        message: 'This attempt was aborted and cannot be changed',
      });
    case 'TM013':
      return new BadRequestException({
        code: 'LIMIT_EXCEEDED',
        message,
        data: detail,
      });
    // The folders under the target were added, moved or deleted since the tree was read.
    case 'TM014':
      return new ConflictException({
        code: 'ORDER_CONFLICT',
        message: 'The folders were changed by someone else. Reload them.',
      });
    case '22023':
      return new BadRequestException({
        code: 'VALIDATION_FAILED',
        message,
        data: detail,
      });
    case '23505':
      if (error.message.includes('test_folders_sibling_name_key')) {
        return new ConflictException({
          code: 'DUPLICATE_NAME',
          message: 'A folder with this name already exists here',
        });
      }

      return new ConflictException({
        code: error.message.includes('automation_key')
          ? 'DUPLICATE_AUTOMATION_KEY'
          : 'DUPLICATE',
        message: error.message.includes('automation_key')
          ? 'Another test case in this space already uses this automation key'
          : 'The value is already in use',
      });
  }

  return tmDbError(logger, action, error);
}
