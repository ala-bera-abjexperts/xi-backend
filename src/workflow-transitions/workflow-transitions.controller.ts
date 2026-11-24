/**
 * @fileoverview REST controller for workflow-transition rule persistence.
 * @module src/workflow-transitions/workflow-transitions.controller
 * @author Rajbha Manek
 */

import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SaveRulesDto } from './dto/save-rules.dto';
import { WorkflowTransitionsService } from './workflow-transitions.service';

@ApiTags('Workflow Transitions')
@ApiBearerAuth()
@Controller('workflow-transitions')
export class WorkflowTransitionsController {
  constructor(private readonly service: WorkflowTransitionsService) {}

  @Put(':id/rules')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({ summary: 'Persist the four rule arrays for a transition' })
  @ApiParam({ name: 'id', description: 'Transition UUID' })
  @ApiResponse({ status: 200, description: 'Rules saved' })
  @ApiResponse({ status: 404, description: 'Transition not found in this org' })
  @ApiResponse({
    status: 422,
    description: 'Validation error (Zod issues or missing refs)',
  })
  async saveRules(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveRulesDto,
  ) {
    const data = await this.service.saveRules(
      id,
      user.organizationId,
      dto,
      user.userId,
    );

    return { data, success: true };
  }
}
