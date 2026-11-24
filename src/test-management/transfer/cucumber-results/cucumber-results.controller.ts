import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
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
import { TestAutomationRunsService } from '../../automation/test-automation-runs.service';
import {
  JunitCommitOptionsDto,
  ResultImportOptionsDto,
  TEST_TRANSFER_LIMITS,
  type JunitCommitResult,
} from '../../dto/test-transfer.dto';
import { TestManagementResponseInterceptor } from '../../test-management-response.interceptor';
import { fileError } from '../shared/transfer-helpers';
import { CucumberResultsService } from './cucumber-results.service';

const RESULTS_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

// custom_fields may hold 20,000 characters of up to 4 bytes each.
const FIELD_BYTES = 80 * 1024;

// Up to 10 files under the field name "file", as one upload.
const resultsUpload = (fields: number, fieldSize: number) =>
  FilesInterceptor('file', TEST_TRANSFER_LIMITS.resultFiles, {
    limits: {
      fileSize: TEST_TRANSFER_LIMITS.junitBytes,
      files: TEST_TRANSFER_LIMITS.resultFiles,
      fields,
      fieldSize,
    },
  });

/** At least one file, and all of them together within the size of one report, checked before any is read. */
function requireFiles(
  files: Express.Multer.File[] | undefined,
): Express.Multer.File[] {
  if (!files || files.length === 0) {
    throw fileError('Choose a report file to upload');
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (total > TEST_TRANSFER_LIMITS.junitBytes) {
    throw fileError(
      'The report files are larger than 10 MB together',
      { bytes: total, max: TEST_TRANSFER_LIMITS.junitBytes },
      'RESULT_FILES_TOO_LARGE',
    );
  }

  return files;
}

/** Marks the CI job the upload names as finished; the upload has already succeeded either way. */
async function withRunClosed(
  runs: TestAutomationRunsService,
  user: RequestUser,
  spaceId: string,
  runId: string | undefined,
  executionId: string,
  result: JunitCommitResult,
): Promise<JunitCommitResult> {
  if (!runId) return result;

  const outcome = await runs.closeByUpload(
    user,
    spaceId,
    runId,
    executionId,
    result,
  );

  return outcome.closed
    ? { ...result, automation_run: { closed: true } }
    : {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          ...(outcome.warning ? [outcome.warning] : []),
        ],
      };
}

/** `:spaceId` and `:executionId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@AllowTestManagementApiKey()
@ApiTags('test-management')
@ApiBearerAuth()
@ApiBearerAuth('tm-api-key')
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/executions/:executionId/junit')
export class CucumberResultsController {
  constructor(
    private readonly results: CucumberResultsService,
    private readonly runs: TestAutomationRunsService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @Throttle(RESULTS_THROTTLE)
  @UseInterceptors(resultsUpload(5, 1024))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Match a JUnit, TestNG, xUnit, Cucumber, Behave or Xray JSON report to the tests of the execution and list what would change; writes nothing',
  })
  preview(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    // Declared so an unexpected form field is refused.
    @Body() options: JunitCommitOptionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.results.previewMany(
      user,
      spaceId,
      executionId,
      requireFiles(files),
      options.format,
    );
  }

  @Post('commit')
  @RequireSpacePermission('manage_test_runs')
  @Throttle(RESULTS_THROTTLE)
  // 7 form fields; custom_fields is the long one.
  @UseInterceptors(resultsUpload(8, FIELD_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Record up to 10 JUnit, TestNG, xUnit, Cucumber, Behave or Xray JSON reports and keep each file as a new version of the execution attachment',
  })
  async commit(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() options: JunitCommitOptionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const result = await this.results.commitMany(
      user,
      spaceId,
      executionId,
      requireFiles(files),
      options,
    );

    return withRunClosed(
      this.runs,
      user,
      spaceId,
      options.automation_run_id,
      executionId,
      result,
    );
  }

  @Post('kept/preview')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @Throttle(RESULTS_THROTTLE)
  @ApiOperation({
    summary:
      'List what the Cucumber report kept on the execution would change; writes nothing',
  })
  previewKept(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.results.previewKept(user, spaceId, executionId);
  }

  @Post('kept/commit')
  @RequireSpacePermission('manage_test_runs')
  @Throttle(RESULTS_THROTTLE)
  @ApiOperation({
    summary:
      'Record the Cucumber report kept on the execution again, once its tests are back to To do',
  })
  commitKept(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.results.commitKept(user, spaceId, executionId);
  }
}

/** A report upload that creates its own execution; `:spaceId`, never `:id` (SpacePermissionsGuard). */
@RequireFeature('module_test_management')
@AllowTestManagementApiKey()
@ApiTags('test-management')
@ApiBearerAuth()
@ApiBearerAuth('tm-api-key')
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/import/results')
export class ResultsImportController {
  constructor(
    private readonly results: CucumberResultsService,
    private readonly runs: TestAutomationRunsService,
  ) {}

  @Post()
  @RequireSpacePermission('manage_test_runs')
  @Throttle(RESULTS_THROTTLE)
  // 14 form fields; custom_fields is the long one, then a description of 10,000 characters.
  @UseInterceptors(resultsUpload(15, FIELD_BYTES))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Create a test execution from up to 10 JUnit, TestNG, xUnit, Cucumber, Behave or Xray JSON reports and record their results',
  })
  async importResults(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() options: ResultImportOptionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const reports = requireFiles(files);

    // Later uploads of the same CI job, such as other shards, go to the execution its first one made.
    const run = options.automation_run_id
      ? await this.runs.uploadTarget(user, spaceId, options.automation_run_id)
      : null;
    const result = await this.results.importResults(
      user,
      spaceId,
      reports,
      options,
      run,
    );

    return result.execution
      ? withRunClosed(
          this.runs,
          user,
          spaceId,
          options.automation_run_id,
          result.execution.id,
          result,
        )
      : result;
  }
}
