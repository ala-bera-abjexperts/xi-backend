/**
 * @fileoverview SCIM 2.0 endpoints for Microsoft Entra ID provisioning,
 * mounted at `/api/v1/scim/v2`. Authenticated by a workspace SCIM token only.
 * @module src/sso/scim.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ScimExceptionFilter } from './scim-exception.filter';
import { ScimTokenGuard, type ScimRequest } from './scim-token.guard';
import { ScimService } from './scim.service';

/**
 * Writes a SCIM response. Handlers own the response (bare `@Res`), so the
 * global envelope never wraps SCIM documents.
 */
function send(res: Response, status: HttpStatus, body?: unknown): void {
  if (body === undefined) {
    res.status(status).end();

    return;
  }

  res.status(status).type('application/scim+json').send(JSON.stringify(body));
}

/**
 * `@Public` skips user auth; {@link ScimTokenGuard} authenticates instead.
 * Throttling is skipped because Entra shares egress IPs and bursts during
 * initial cycles. No `@RequireFeature`: SCIM keeps working in the licence grace.
 */
@Public()
@SkipThrottle()
@UseGuards(ScimTokenGuard)
@UseFilters(ScimExceptionFilter)
@Controller('scim/v2')
export class ScimController {
  /**
   * @param {ScimService} scimService - SCIM provisioning logic
   */
  constructor(private readonly scimService: ScimService) {}

  @Get('ServiceProviderConfig')
  getServiceProviderConfig(@Res() res: Response): void {
    send(res, HttpStatus.OK, this.scimService.getServiceProviderConfig());
  }

  @Get('Users')
  async listUsers(
    @Req() req: ScimRequest,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(res, HttpStatus.OK, await this.scimService.listUsers(req.scim, query));
  }

  @Get('Users/:id')
  async getUser(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    send(res, HttpStatus.OK, await this.scimService.getUser(req.scim, id));
  }

  @Post('Users')
  async createUser(
    @Req() req: ScimRequest,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      HttpStatus.CREATED,
      await this.scimService.createUser(req.scim, body),
    );
  }

  @Patch('Users/:id')
  async patchUser(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      HttpStatus.OK,
      await this.scimService.patchUser(req.scim, id, body),
    );
  }

  @Delete('Users/:id')
  async deleteUser(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.scimService.deleteUser(req.scim, id);
    send(res, HttpStatus.NO_CONTENT);
  }

  @Get('Groups')
  async listGroups(
    @Req() req: ScimRequest,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      HttpStatus.OK,
      await this.scimService.listGroups(req.scim, query),
    );
  }

  @Get('Groups/:id')
  async getGroup(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      HttpStatus.OK,
      await this.scimService.getGroup(req.scim, id, query),
    );
  }

  @Post('Groups')
  async createGroup(
    @Req() req: ScimRequest,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      HttpStatus.CREATED,
      await this.scimService.createGroup(req.scim, body),
    );
  }

  @Patch('Groups/:id')
  async patchGroup(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    await this.scimService.patchGroup(req.scim, id, body);
    send(res, HttpStatus.NO_CONTENT);
  }

  @Delete('Groups/:id')
  async deleteGroup(
    @Req() req: ScimRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.scimService.deleteGroup(req.scim, id);
    send(res, HttpStatus.NO_CONTENT);
  }
}
