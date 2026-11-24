/**
 * @fileoverview Help Center supplementary endpoints for space-aware filtering.
 * Provides the space list and enabled-module list used by the published
 * DocumentationList and SupportTicketList site-studio elements.
 * @module src/help-center/help-center-spaces.controller
 */

import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { HelpCenterService } from './help-center.service';

@ApiTags('Help Center')
@ApiBearerAuth()
@Controller('help-center')
export class HelpCenterSpacesController {
  constructor(private readonly service: HelpCenterService) {}

  /**
   * GET /api/v1/help-center/spaces
   *
   * Returns the spaces the authenticated user is a member of.
   * Used by the published site-studio elements to populate the space selector.
   */
  @Get('spaces')
  @ApiOperation({ summary: 'List spaces the current user belongs to' })
  getUserSpaces(
    @CurrentUser() user: RequestUser,
  ): Promise<
    Array<{ id: string; name: string; color: string | null; key: string }>
  > {
    return this.service.getUserSpaces(user.userId);
  }

  /**
   * GET /api/v1/help-center/space-modules?spaceId=<uuid>
   *
   * Returns the enabled module keys for the given space.
   * Returns an empty array if the user is not a member of that space.
   */
  @Get('space-modules')
  @ApiOperation({ summary: 'Get enabled module keys for a space' })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  getSpaceModules(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string,
  ): Promise<string[]> {
    return this.service.getSpaceModules(
      spaceId,
      user.userId,
      user.organizationId,
    );
  }

}
