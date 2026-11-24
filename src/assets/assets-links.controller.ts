import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsLinksService } from './assets-links.service';
import { CreateLinkDto } from './dto/create-link.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Links')
@ApiBearerAuth()
// SECURITY (H2): require space membership + list view (services scope org-only).
@UseGuards(SpacePermissionsGuard)
@RequireSpacePermission('can_view_lists')
@Controller('spaces/:spaceId/lists/items/:itemId/links')
export class AssetsLinksController {
  constructor(private readonly service: AssetsLinksService) {}

  @Get()
  @ApiOperation({ summary: 'List cross-entity links for an item' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getAll(itemId, user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a link' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateLinkDto,
  ) {
    return this.service.create(itemId, user.organizationId, user.userId, dto);
  }

  @Delete(':linkId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a link' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'linkId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.service.delete(linkId, user.organizationId);
  }
}
