/**
 * @fileoverview MCP-facing REST controller for space-safe wiki WRITES under
 * `/wiki/mine` — create and update (optimistic-locked). These back the MCP
 * `wiki.create` / `wiki.update` tools. Unlike the org/space `/spaces/:spaceId/wiki`
 * routes (which use SpacePermissionsGuard + assertPageAccess and return 403 on a
 * non-member / ACL denial, leaking existence), these carry the global auth chain
 * only (no @RequireSpacePermission / no space guard) plus the class-level
 * `@RequireFeature('module_wiki')`, so app-auth and the MCP service token behave
 * identically; all safety — space membership, space-level permission, page-level
 * ACL, and the uniform 404 — lives in WikiMineWriteService.
 * @module src/wiki/wiki-mine-write.controller
 * @author Prince Jadiya
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiMineWriteService } from './wiki-mine-write.service';
import { MineCreateWikiPageDto } from './dto/mine-create-wiki-page.dto';
import { MineUpdateWikiPageDto } from './dto/mine-update-wiki-page.dto';

@RequireFeature('module_wiki')
@ApiTags('Wiki')
@ApiBearerAuth()
@Controller('wiki/mine')
export class WikiMineWriteController {
  constructor(private readonly service: WikiMineWriteService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a wiki page in a space the caller can write to',
    description:
      'Creates a wiki page in the target space only when the authenticated ' +
      'caller is an org admin/owner or an active member of that space holding ' +
      'the space-level create_wiki_pages permission, and (when parentPageId is ' +
      'given) can_create on the parent. Defaults to a draft. Content is ' +
      'sanitized server-side. Non-member, nonexistent, cross-org, and ' +
      'inaccessible-parent all return an identical 404 (anti-probing). Backs ' +
      'the MCP wiki.create tool.',
  })
  @ApiResponse({ status: 201, description: 'Wiki page created' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found or not writable' })
  async createMyWikiPage(
    @CurrentUser() user: RequestUser,
    @Body() dto: MineCreateWikiPageDto,
  ) {
    return this.service.createWikiPage(user, dto);
  }

  @Put(':pageId')
  @ApiOperation({
    summary: 'Update a wiki page the caller can edit (optimistic-locked)',
    description:
      'Updates whitelisted fields of a wiki page only when the caller holds the ' +
      'space-level edit_wiki_pages permission AND the page-level can_edit ACL in ' +
      'the page’s space. Requires expectedUpdatedAt; a stale value returns 409 ' +
      'with the current updatedAt. The page is never moved to another space or ' +
      'parent. Non-member, nonexistent, archived, cross-org, and ACL-denied all ' +
      'return an identical 404 (anti-probing). Backs the MCP wiki.update tool.',
  })
  @ApiParam({ name: 'pageId', description: 'Wiki page UUID' })
  @ApiResponse({ status: 200, description: 'Wiki page updated' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Page not found or not writable' })
  @ApiResponse({ status: 409, description: 'Optimistic updated_at conflict' })
  async updateMyWikiPage(
    @CurrentUser() user: RequestUser,
    @Param('pageId') pageId: string,
    @Body() dto: MineUpdateWikiPageDto,
  ) {
    return this.service.updateWikiPage(user, pageId, dto);
  }
}
