import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
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

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  CreateTestAutomationConfigDto,
  CreateTestAutomationWorkflowFileDto,
  DeleteTestAutomationFilesDto,
  ListTestAutomationConfigsQueryDto,
  ListTestAutomationRunsQueryDto,
  ListTestAutomationSpecFilesQueryDto,
  SaveTestAutomationFileDto,
  SendCiVariablesDto,
  StartTestAutomationRunDto,
  TestAutomationFilePathQueryDto,
  TestAutomationFileVersionDto,
  TestAutomationTargetQueryDto,
  TriggerTestAutomationCaseDto,
  TriggerTestAutomationDto,
  UpdateTestAutomationConfigDto,
  UpdateTestAutomationWorkflowFileDto,
} from '../dto/test-automation.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { AUTOMATION_LIMITS, invalid } from './automation-inputs';
import { TestAutomationCiService } from './test-automation-ci.service';
import { TestAutomationCiVariablesService } from './test-automation-ci-variables.service';
import { TestAutomationConfigsService } from './test-automation-configs.service';
import { TestAutomationRunnerService } from './test-automation-runner.service';
import { TestAutomationRunsService } from './test-automation-runs.service';

/**
 * CI jobs of a space. The space param is `:spaceId` and the setting is `:configId`, never `:id`:
 * SpacePermissionsGuard falls back to `params.id` as the space id.
 */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/automation')
export class TestAutomationController {
  constructor(
    private readonly configs: TestAutomationConfigsService,
    private readonly ci: TestAutomationCiService,
    private readonly runs: TestAutomationRunsService,
    private readonly ciVariables: TestAutomationCiVariablesService,
    // Optional only so older specs can build the controller with fewer services.
    @Optional() private readonly runner?: TestAutomationRunnerService,
  ) {}

  @Get('images')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Runner images this server allows, and whether the runner is on',
  })
  images() {
    return this.configs.images();
  }

  @Get('runner')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'The shared test runner: on or off, how busy, and this space queue',
  })
  runnerStatus(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runner!.status(user, spaceId);
  }

  @Post('runner/start')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('execute_tests')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Starts the shared test runner when it is off; does nothing when it runs',
  })
  startRunner(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runner!.start(user, spaceId);
  }

  @Get('test-counts')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'How many tests of a plan or execution have an automated test type',
  })
  testCounts(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: TestAutomationTargetQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.testCounts(user.organizationId, spaceId, query);
  }

  @Get('repositories')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Repositories enabled in Tenant Configuration, to pick from',
  })
  repositories(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.gitRepositories(user, spaceId);
  }

  @Get('repositories/:repositoryId/workflow-files')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Workflow files on the default branch of a connected repository',
  })
  workflowFiles(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.repositoryWorkflowFiles(user, spaceId, repositoryId);
  }

  @Get('repositories/:repositoryId/workflow-files/:fileName')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Read one workflow file on the default branch, to edit it',
  })
  workflowFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @Param('fileName') fileName: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.repositoryWorkflowFile(
      user,
      spaceId,
      repositoryId,
      fileName,
    );
  }

  @Post('repositories/:repositoryId/workflow-files')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary:
      'Commit a new workflow file to the default branch; never overwrites',
  })
  createWorkflowFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @Body() dto: CreateTestAutomationWorkflowFileDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.createRepositoryWorkflowFile(
      user,
      spaceId,
      repositoryId,
      dto,
    );
  }

  @Put('repositories/:repositoryId/workflow-files/:fileName')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary:
      'Commit a change to a workflow file on the default branch; refused if the file changed since it was read',
  })
  updateWorkflowFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @Param('fileName') fileName: string,
    @Body() dto: UpdateTestAutomationWorkflowFileDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.updateRepositoryWorkflowFile(
      user,
      spaceId,
      repositoryId,
      fileName,
      dto,
    );
  }

  @Get('repositories/:repositoryId/branches')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Branches of a connected repository' })
  branches(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.repositoryBranches(user, spaceId, repositoryId);
  }

  @Get('ci-servers')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary:
      'Jenkins servers connected in Tenant Configuration, to pick from; no logins',
  })
  ciServers(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.ciServerList(user, spaceId);
  }

  @Get('ci-servers/:serverId/jobs')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Jobs and folders of a connected Jenkins server' })
  ciServerJobs(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.ciServerJobs(user, spaceId, serverId);
  }

  @Get('configs')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'CI job settings of a space; header values are never returned',
  })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestAutomationConfigsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.list(
      user,
      spaceId,
      query.archived === true,
      query.kind,
    );
  }

  @Get('configs/:configId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'One CI job setting' })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.get(user, spaceId, configId);
  }

  @Post('configs')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Create a CI job setting' })
  create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateTestAutomationConfigDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.create(user, spaceId, dto);
  }

  @Put('configs/:configId')
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Change a CI job setting' })
  update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: UpdateTestAutomationConfigDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.update(user, spaceId, configId, dto);
  }

  @Post('configs/:configId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Archive a CI job setting' })
  archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.archive(user, spaceId, configId);
  }

  @Post('configs/:configId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Restore an archived CI job setting',
    description:
      'Refused with 409 DUPLICATE_NAME when an active job has the same name.',
  })
  restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.restore(user, spaceId, configId);
  }

  @Delete('configs/:configId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Delete a CI job setting; its past runs are kept',
    description: 'Refused with 409 RUNS_IN_PROGRESS while a run is going.',
  })
  remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.remove(user, spaceId, configId);
  }

  @Post('configs/:configId/ci-variables')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Create an API key and put it into the CI tool of a connected job',
    description:
      'GitLab gets project variables and Jenkins a system credential; for GitHub the key is returned once to paste as a repository secret. Earlier keys of the job are revoked after a successful send.',
  })
  sendCiVariables(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: SendCiVariablesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.ciVariables.send(user, spaceId, configId, dto);
  }

  @Post('configs/:configId/zip')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: AUTOMATION_LIMITS.zipBytes, files: 1, fields: 0 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload the test project as a zip (at most 50 MB)' })
  uploadZip(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw invalid('file', 'Choose a .zip file to upload');

    return this.configs.uploadZip(user, spaceId, configId, file);
  }

  // Reads are throttled less than writes: going through a project opens many files in a minute.
  @Get('configs/:configId/files')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Names and sizes of the files in the zip' })
  listFiles(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.listFiles(user, spaceId, configId);
  }

  @Get('configs/:configId/files/content')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'One text file of the zip, at most 1 MB' })
  readFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Query() query: TestAutomationFilePathQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.readFile(user, spaceId, configId, query.path);
  }

  @Put('configs/:configId/files/content')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create or replace a text file in the zip' })
  saveFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: SaveTestAutomationFileDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.saveFile(user, spaceId, configId, dto);
  }

  @Post('configs/:configId/files')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: AUTOMATION_LIMITS.zipBytes,
        files: 1,
        fields: 2,
        fieldSize: 8192,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload one file into the zip (at most 50 MB)' })
  uploadFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: TestAutomationFileVersionDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw invalid('file', 'Choose a file to upload');

    return this.configs.uploadFile(user, spaceId, configId, dto, file);
  }

  @Delete('configs/:configId/files')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Delete one file from the zip' })
  deleteFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Query() query: TestAutomationFileVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.deleteFile(user, spaceId, configId, query);
  }

  @Post('configs/:configId/files/delete')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Delete several files from the zip' })
  deleteFiles(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: DeleteTestAutomationFilesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.deleteFiles(user, spaceId, configId, dto);
  }

  @Get('configs/:configId/spec-files')
  @RequireSpacePermission('execute_tests')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Names of the test files a run of this setting can be limited to',
  })
  specFiles(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Query() query: ListTestAutomationSpecFilesQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.specFiles(user, spaceId, configId, query);
  }

  // Downloads the stored zip, so it is throttled like a write.
  @Get('configs/:configId/framework')
  @RequireSpacePermission('view_tests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The test framework an auto run of this zip setting would use',
  })
  framework(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.configs.framework(user, spaceId, configId);
  }

  @Post('configs/:configId/trigger')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('execute_tests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start the CI job of a setting for a test plan or execution',
    description:
      'Results come back through the results import with an API key. The same request_id returns the first start.',
  })
  async trigger(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: TriggerTestAutomationDto,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.ci.trigger(user, spaceId, configId, dto);
    const [visible] = await this.runs.forViewer(user, spaceId, [run]);

    return visible;
  }

  @Post('configs/:configId/trigger-case')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('execute_tests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start the CI job of a setting for one automated test case',
    description:
      'Creates an execution holding only that test, then starts the job for it. The same request_id returns the first start.',
  })
  async triggerCase(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body() dto: TriggerTestAutomationCaseDto,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.ci.triggerCase(user, spaceId, configId, dto);
    const [visible] = await this.runs.forViewer(user, spaceId, [run]);

    return visible;
  }

  @Post('runs')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('execute_tests')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Queue a run of automated tests on the runner',
    description: 'The same request_id returns the first start.',
  })
  async startRun(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: StartTestAutomationRunDto,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.runs.start(user, spaceId, dto);
    const [visible] = await this.runs.forViewer(user, spaceId, [run]);

    return visible;
  }

  @Get('runs')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Starts of CI jobs in a space, newest first' })
  async listRuns(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListTestAutomationRunsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    // "me" is the person asking, so a screen can show its own history without knowing its user id.
    const startedBy = query.startedBy === 'me' ? user.userId : query.startedBy;
    const page = await this.runs.list(user.organizationId, spaceId, {
      ...query,
      startedBy,
    });

    return {
      ...page,
      items: await this.runs.forViewer(user, spaceId, page.items),
    };
  }

  @Get('runs/:runId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'One start of a CI job' })
  async getRun(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const run = await this.runs.get(user.organizationId, spaceId, runId);
    const [visible] = await this.runs.forViewer(user, spaceId, [run]);

    return visible;
  }

  @Get('runs/:runId/ci-jobs')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Jobs and steps of the workflow a CI run started',
  })
  ciJobs(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.ciJobs(user.organizationId, spaceId, runId);
  }

  @Get('runs/:runId/ci-jobs/:jobId/log')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The end of one job log of a workflow a CI run started',
    description:
      'Read from GitHub each time; at most the last 256 KB, with the connection token hidden.',
  })
  ciJobLog(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.ciJobLog(user.organizationId, spaceId, runId, jobId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary: 'Stop a workflow started through the GitHub connection',
  })
  cancelRun(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.cancel(user, spaceId, runId);
  }

  @Delete('runs/:runId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('manage_test_runs')
  @ApiOperation({
    summary: 'Delete one run record; results already recorded are kept',
    description: 'Refused with 409 RUN_IN_PROGRESS while the run is going.',
  })
  removeRun(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.runs.remove(user, spaceId, runId);
  }
}
