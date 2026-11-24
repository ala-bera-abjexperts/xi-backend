import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { LinkedItemsQueryDto } from '../dto/linked-items-query.dto';
import { RequirementTicketSearchQueryDto } from '../dto/requirement-ticket-search.dto';
import { LinkRequirementsDto } from '../dto/test-coverage.dto';
import {
  LinkTaskItemsDto,
  TASK_LINK_KINDS,
  TaskLinkTypeQueryDto,
  type TaskLinkKind,
} from '../dto/test-requirement-link.dto';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { TestRequirementLinksService } from './test-requirement-links.service';

const KIND_VALUES = Object.fromEntries(
  TASK_LINK_KINDS.map((kind) => [kind, kind]),
);
const kindPipe = new ParseEnumPipe(KIND_VALUES);

// Each call checks every ticket's visibility, so a high rate would let a caller probe ticket ids.
const LINK_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

/** `:spaceId`, `:taskId`, `:itemId` and `:caseId`, never `:id`: SpacePermissionsGuard falls back to `params.id` as the space id. */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management')
export class TestRequirementLinksController {
  constructor(private readonly service: TestRequirementLinksService) {}

  // One GET per kind: a `:kind` GET would also catch the defects route `tasks/:taskId/defects`.
  @Get('tasks/:taskId/cases')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Test cases linked to a ticket, by key (max 500)' })
  listCases(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: TaskLinkTypeQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user, spaceId, taskId, 'cases', query.link_type);
  }

  @Get('tasks/:taskId/sets')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Test sets linked to a ticket, by key (max 500)' })
  listSets(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: TaskLinkTypeQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user, spaceId, taskId, 'sets', query.link_type);
  }

  @Get('tasks/:taskId/plans')
  @RequireSpacePermission('view_tests')
  @ApiOperation({ summary: 'Test plans linked to a ticket, by key (max 500)' })
  listPlans(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: TaskLinkTypeQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(user, spaceId, taskId, 'plans', query.link_type);
  }

  @Get('tasks/:taskId/linked-items')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Test cases, sets and plans linked to a ticket in one list, optionally sorted (max 500 each)',
  })
  listLinkedItems(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: LinkedItemsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listLinkedItems(user, spaceId, taskId, query);
  }

  @Post('tasks/:taskId/:kind')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary:
      'Link up to 500 test cases, sets or plans (kind) to a ticket; skipped ones are listed',
  })
  link(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('kind', kindPipe) kind: TaskLinkKind,
    @Body() dto: LinkTaskItemsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.link(user, spaceId, taskId, kind, dto);
  }

  @Delete('tasks/:taskId/:kind/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary: 'Unlink a test case, set or plan (kind) from a ticket',
  })
  unlink(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('kind', kindPipe) kind: TaskLinkKind,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query() query: TaskLinkTypeQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.unlink(
      user,
      spaceId,
      taskId,
      kind,
      itemId,
      query.link_type,
    );
  }

  @Get('requirements/tickets')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Tickets of the space that can be linked as requirements; Test Management tickets are left out',
  })
  searchRequirementTickets(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: RequirementTicketSearchQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.searchRequirementTickets(user, spaceId, query);
  }

  @Get('cases/:caseId/tasks')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary:
      'Tickets linked to a test case; hidden ones are restricted (max 500)',
  })
  listCaseTasks(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listCaseTasks(user, spaceId, caseId);
  }

  @Post('cases/:caseId/requirements')
  @HttpCode(HttpStatus.OK)
  @Throttle(LINK_THROTTLE)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({
    summary:
      'Link up to 50 tickets to a test case as requirements; all are checked before any is saved',
  })
  linkCaseRequirements(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: LinkRequirementsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.linkCaseRequirements(user, spaceId, caseId, dto);
  }

  @Delete('cases/:caseId/requirements/:taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSpacePermission('edit_tests')
  @ApiOperation({ summary: 'Unlink a requirement ticket from a test case' })
  unlinkCaseRequirement(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.unlinkCaseRequirement(user, spaceId, caseId, taskId);
  }
}
