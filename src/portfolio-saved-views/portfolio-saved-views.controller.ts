import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateSavedViewDto } from './dto/create-saved-view.dto';
import { UpdateSavedViewDto } from './dto/update-saved-view.dto';
import { PortfolioSavedViewsService } from './portfolio-saved-views.service';

@RequireFeature('module_portfolios')
@ApiTags('Portfolio Saved Views')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('portfolio-saved-views')
export class PortfolioSavedViewsController {
  constructor(private readonly service: PortfolioSavedViewsService) {}

  @Get()
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary: 'List current user’s saved Gantt views for a portfolio',
  })
  @ApiQuery({ name: 'portfolio_id', required: true, type: String })
  @ApiResponse({ status: 200, description: 'User saved-view list.' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('portfolio_id', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.list(user.organizationId, user.userId, portfolioId);
  }

  @Post()
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Create a saved Gantt view' })
  @ApiResponse({ status: 201, description: 'Saved view created.' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSavedViewDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Update a saved Gantt view (owner only)' })
  @ApiResponse({ status: 200, description: 'Saved view updated.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedViewDto,
  ) {
    return this.service.update(user.organizationId, user.userId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Delete a saved Gantt view (owner only)' })
  @ApiResponse({ status: 200, description: 'Saved view deleted.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  delete(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(user.organizationId, user.userId, id);
  }

  @Post(':id/set-default')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary:
      'Mark this saved view as the default for the current user + portfolio',
  })
  @ApiResponse({ status: 200, description: 'Default updated.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  setDefault(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.setDefault(user.organizationId, user.userId, id);
  }
}
