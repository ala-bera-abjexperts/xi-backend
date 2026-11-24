import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { BudgetTimelinePeopleQueryDto } from './budget-timeline-people-query.dto';
import { BudgetTimelinePeopleService } from './budget-timeline-people.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class BudgetTimelinePeopleController {
  constructor(private readonly peopleService: BudgetTimelinePeopleService) {}

  @Get('budget-timeline/people')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary: 'People planned per month on the Ressource Tree timeline',
  })
  async getPeople(
    @CurrentUser() user: RequestUser,
    @Query() query: BudgetTimelinePeopleQueryDto,
  ) {
    const data = await this.peopleService.getPeople(
      user.organizationId,
      user.userId,
      {
        taskIds: query.task_ids,
        depth: query.depth,
        spaceId: query.space_id,
        from: query.from,
        to: query.to,
        tz: query.tz,
      },
    );
    return { data };
  }
}
