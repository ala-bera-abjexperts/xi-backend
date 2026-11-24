import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  IssueGroupFiltersDto,
  IssueGroupMenuQueryDto,
  IssueGroupTasksQueryDto,
} from './issue-groups.dto';
import { IssueGroupsService } from './issue-groups.service';

/** Reads behind the "Issue groups" menu and page. Access is enforced per space in the service. */
@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('issue-groups')
export class IssueGroupsController {
  constructor(private readonly service: IssueGroupsService) {}

  @Get('menu')
  @ApiOperation({ summary: 'Issue group fields shown in a space menu' })
  menu(
    @CurrentUser() user: RequestUser,
    @Query() q: IssueGroupMenuQueryDto,
  ) {
    return this.service.getMenu(user, q.spaceId);
  }

  @Get(':fieldId')
  @ApiOperation({ summary: 'One issue group field with its options' })
  field(
    @CurrentUser() user: RequestUser,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
  ) {
    return this.service.getField(user, fieldId);
  }

  @Get(':fieldId/summary')
  @ApiOperation({ summary: 'Ticket counts per option and status category' })
  summary(
    @CurrentUser() user: RequestUser,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Query() q: IssueGroupFiltersDto,
  ) {
    return this.service.getSummary(user, fieldId, q);
  }

  @Get(':fieldId/tasks')
  @ApiOperation({ summary: 'One page of the tickets of one group' })
  tasks(
    @CurrentUser() user: RequestUser,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Query() q: IssueGroupTasksQueryDto,
  ) {
    return this.service.getTasks(user, fieldId, q);
  }

  @Get(':fieldId/options/:optionId/usage')
  @ApiOperation({ summary: 'Tickets using an option, whatever their type' })
  usage(
    @CurrentUser() user: RequestUser,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
  ) {
    return this.service.getOptionUsage(user, fieldId, optionId);
  }
}
