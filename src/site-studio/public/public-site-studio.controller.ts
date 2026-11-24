import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { CreatePublicTicketDto } from './dto/public-site-studio.dto';
import { PublicSiteStudioService } from './public-site-studio.service';

@ApiTags('Public Site Studio')
@ApiBearerAuth()
@Controller('public/site-studio')
export class PublicSiteStudioController {
  constructor(private readonly service: PublicSiteStudioService) {}

  @Public()
  @Get('page')
  @ApiOperation({
    summary: 'Resolve published Site Studio page by domain/path',
  })
  @ApiQuery({ name: 'domain', required: true })
  @ApiQuery({ name: 'path', required: false })
  async resolvePage(
    @Query('domain') domain?: string,
    @Query('path') path?: string,
  ) {
    return this.service.resolvePublishedPage(domain ?? '', path ?? '');
  }

  @Public()
  @Get('resolve-host')
  @ApiOperation({
    summary:
      'Classify a host as a published Site Studio site (for edge routing)',
  })
  @ApiQuery({ name: 'host', required: true })
  async resolveHost(@Query('host') host?: string) {
    return this.service.resolveHost(host ?? '');
  }

  /**
   * On-demand TLS gate for the on-prem Caddy edge (`on_demand_tls { ask … }`).
   *
   * Caddy calls this before issuing a certificate for an unknown hostname and proceeds
   * ONLY on a 2xx, so the contract is a bare status code — 200 to allow, 403 to refuse.
   * No body is required and none is meaningful to Caddy.
   *
   * Reached only from inside the container network (the edge dials `backend:3001`), but
   * it is `@Public()` because the caller is a proxy, not a user. It leaks nothing beyond
   * "this hostname is a published site here", which is by definition public information.
   * Throttled because Caddy retries on failure and a hostile client could otherwise turn
   * cert issuance into a request amplifier.
   */
  @Public()
  @Get('tls-ask')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'On-demand TLS gate: 200 if the host is a verified domain of a published funnel, else 403',
  })
  @ApiQuery({ name: 'domain', required: true })
  async tlsAsk(
    @Query('domain') domain?: string,
    @Query('host') host?: string,
  ): Promise<void> {
    // Caddy sends `?domain=`; accept `?host=` too so the gate keeps working if the
    // Caddyfile is ever written with the other spelling.
    const allowed = await this.service.isTlsIssuanceAllowed(
      domain ?? host ?? '',
    );

    if (!allowed) {
      throw new ForbiddenException('Domain not eligible for TLS issuance');
    }
  }

  @Public()
  @Get('tasks')
  @ApiOperation({
    summary: 'List space tasks for published pages (public or authenticated)',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiQuery({ name: 'maxItems', required: false })
  @ApiQuery({ name: 'assignedToMe', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  async listTasks(
    @CurrentUser() user: RequestUser | undefined,
    @Query('spaceId') spaceId?: string,
    @Query('maxItems') maxItems?: string,
    @Query('assignedToMe') assignedToMe?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
  ) {
    return this.service.listTasks(
      user,
      spaceId ?? '',
      maxItems,
      assignedToMe,
      status,
      page,
    );
  }

  @Public()
  @Get('can-edit')
  @ApiOperation({
    summary:
      'Whether the caller may edit this funnel (published-view edit button)',
    description:
      'Backs the "edit this page" affordance on a published Site Studio page (XE-T453). ' +
      'Always 200 with { canEdit }: anonymous, cross-org, unknown funnel and ' +
      'insufficient-permission all return false rather than 401/403/404, so a public ' +
      'visitor cannot probe which funnels exist.',
  })
  @ApiQuery({ name: 'funnelId', required: true })
  async canEdit(
    @CurrentUser() user: RequestUser | undefined,
    @Query('funnelId') funnelId?: string,
  ) {
    return this.service.canEditFunnel(user, funnelId ?? '');
  }

  @Public()
  @Get('processes')
  @ApiOperation({
    summary:
      'List space processes for published pages (public or authenticated)',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiQuery({ name: 'maxItems', required: false })
  async listProcesses(
    @CurrentUser() user: RequestUser | undefined,
    @Query('spaceId') spaceId?: string,
    @Query('maxItems') maxItems?: string,
  ) {
    return this.service.listProcesses(user, spaceId ?? '', maxItems);
  }

  @Public()
  @Get('wiki')
  @ApiOperation({
    summary:
      'List published wiki pages for published pages (public or authenticated)',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiQuery({ name: 'maxItems', required: false })
  @ApiQuery({ name: 'rootOnly', required: false })
  @ApiQuery({ name: 'rootPageId', required: false })
  @ApiQuery({ name: 'labelIds', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listWikiPages(
    @CurrentUser() user: RequestUser | undefined,
    @Query('spaceId') spaceId?: string,
    @Query('maxItems') maxItems?: string,
    @Query('rootOnly') rootOnly?: string,
    @Query('rootPageId') rootPageId?: string,
    @Query('labelIds') labelIds?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listWikiPages(
      user,
      spaceId ?? '',
      maxItems,
      rootOnly,
      rootPageId,
      labelIds,
      search,
    );
  }

  @Public()
  @Get('wiki/:pageId/macros/:ordinal')
  @ApiOperation({
    summary: 'Resolve one stored live wiki macro for a published page',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  async getWikiMacro(
    @CurrentUser() user: RequestUser | undefined,
    @Param('pageId') pageId: string,
    @Param('ordinal') ordinal: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.service.resolvePublicWikiMacro(
      user,
      spaceId ?? '',
      pageId,
      ordinal,
    );
  }

  @Public()
  @Get('wiki/:pageId')
  @ApiOperation({
    summary: 'Get one published wiki page (public or authenticated)',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  async getWikiPage(
    @CurrentUser() user: RequestUser | undefined,
    @Param('pageId') pageId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.service.getWikiPage(user, spaceId ?? '', pageId);
  }

  /**
   * Resolve a label-backed File Explorer widget on a published page.
   *
   * The space and label ids come from the STORED element (located by `elementId`
   * inside the published page's content), never from the query string — the
   * page→element binding is the whole authorisation.
   */
  @Public()
  @Get('files')
  @ApiOperation({
    summary:
      'Resolve a label-backed file list bound to a published page element',
  })
  @ApiQuery({ name: 'domain', required: true })
  @ApiQuery({ name: 'path', required: false })
  @ApiQuery({ name: 'elementId', required: true })
  async listFiles(
    @Query('domain') domain?: string,
    @Query('path') path?: string,
    @Query('elementId') elementId?: string,
  ) {
    return this.service.listFilesForElement(
      domain ?? '',
      path ?? '',
      elementId ?? '',
    );
  }

  /**
   * Download one file of a label-backed File Explorer widget.
   *
   * Label mode mints no shares, so there is no token to present. The element is
   * re-resolved from `domain`+`path`+`elementId` exactly as `GET files` does and
   * `nodeId` is served ONLY if it is in that element's own label set — the
   * page→element binding is again the whole authorisation.
   *
   * Mirrors `GET /public/file-explorer/:token/download`: a 302 to a short-TTL
   * signed URL carrying `Content-Disposition: attachment`.
   * `@Res()` bypasses the global ResponseInterceptor — MUST stay.
   */
  @Public()
  @Get('files/download')
  @ApiOperation({
    summary: 'Download one file of a label-backed widget bound to a page',
  })
  @ApiQuery({ name: 'domain', required: true })
  @ApiQuery({ name: 'path', required: false })
  @ApiQuery({ name: 'elementId', required: true })
  @ApiQuery({ name: 'nodeId', required: true })
  async downloadFile(
    @Res() res: Response,
    @Query('domain') domain?: string,
    @Query('path') path?: string,
    @Query('elementId') elementId?: string,
    @Query('nodeId') nodeId?: string,
  ): Promise<void> {
    const signedUrl = await this.service.getElementFileDownloadUrl(
      domain ?? '',
      path ?? '',
      elementId ?? '',
      nodeId ?? '',
    );

    res.setHeader('Cache-Control', 'no-store, private');
    res.redirect(HttpStatus.FOUND, signedUrl);
  }

  @Public()
  @Get('ticket-spaces')
  @ApiOperation({
    summary:
      'List allowed active ticket target spaces for a published page (public or authenticated)',
  })
  @ApiQuery({ name: 'spaceIds', required: false })
  async listTicketSpaces(
    @CurrentUser() user: RequestUser | undefined,
    @Query('spaceIds') spaceIds?: string,
  ) {
    return this.service.listTicketSpaces(user, spaceIds ?? '');
  }

  @Post('ticket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a published ticket form as an authenticated user',
  })
  async createTicket(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePublicTicketDto,
  ) {
    return this.service.createTicket(user, dto);
  }
}
