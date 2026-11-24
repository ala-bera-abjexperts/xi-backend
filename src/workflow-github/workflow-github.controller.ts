/**
 * @fileoverview REST controller for `/workflow-github`. Workflow-owned GitHub
 * connection (PAT-based) + repo picker backing the workflow git triggers, on both
 * ORG-scoped and SPACE-scoped workflows.
 *
 * Every route is guarded by {@link PermissionsGuard} +
 * `@RequirePermissions('can_edit_workflows')` — the SAME guard `workflows.controller`
 * uses to edit org and space workflows. It checks org-level `can_edit_workflows`,
 * then falls back to space-level `edit_workflows` when a `spaceId` is present. That
 * fallback reads `spaceId` from the QUERY (never the body), so `spaceId` is an
 * optional QUERY param on all routes — omitted for org-scoped workflows.
 * Global prefix is `api/v1`.
 * @module src/workflow-github/workflow-github.controller
 * @author Ala Bera
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
import { WorkflowGithubService } from './workflow-github.service';

@ApiTags('Workflow GitHub')
@ApiBearerAuth()
@Controller('workflow-github')
export class WorkflowGithubController {
  constructor(private readonly service: WorkflowGithubService) {}

  // Connect (or replace) the scope's GitHub PAT. spaceId is an optional QUERY
  // param (omitted = org-level) so PermissionsGuard's space fallback can read it.
  @Post('connect')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary: 'Connect a GitHub Personal Access Token (org- or space-scoped)',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({
    status: 201,
    description: 'Connected; token stored encrypted',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing token or invalid token',
  })
  async connect(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string | undefined,
    @Body() body: { token?: string; displayName?: string },
  ) {
    if (!body.token) throw new BadRequestException('token is required');

    return this.service.connect({
      organizationId: user.organizationId,
      spaceId: spaceId || null,
      token: body.token,
      displayName: body.displayName,
      createdBy: user.userId,
    });
  }

  // Secret-free connection summary for the scope (org-level when spaceId omitted).
  @Get('connection')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary: 'Get the active GitHub connection for the scope (no secret)',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Connection summary' })
  async getConnection(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string | undefined,
  ) {
    return this.service.getConnection(user.organizationId, spaceId || null);
  }

  // Read-only feed of recent git-trigger events for the scope (org-level when
  // spaceId omitted). Newest first, capped server-side.
  @Get('trigger-events')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({ summary: 'List recent git-trigger events for the scope' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'workflowId', required: false })
  @ApiResponse({ status: 200, description: 'Recent git-trigger events' })
  async listTriggerEvents(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
    @Query('workflowId') workflowId?: string,
  ) {
    const data = await this.service.listTriggerEvents(
      user.organizationId,
      spaceId || null,
      workflowId || null,
    );

    return { data };
  }

  // List the connected account's repositories for the scope.
  @Get('repos')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({ summary: "List the connected GitHub account's repositories" })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Repository list' })
  @ApiResponse({ status: 401, description: 'GitHub token revoked/expired' })
  async listRepos(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string | undefined,
  ) {
    const data = await this.service.listRepos(
      user.organizationId,
      spaceId || null,
    );

    return { data };
  }

  // Revoke the scope's active connection.
  @Delete('connection')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({ summary: "Disconnect the scope's GitHub connection" })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Disconnected' })
  async disconnect(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string | undefined,
  ) {
    await this.service.disconnect(user.organizationId, spaceId || null);

    return { data: { ok: true } };
  }

  // Register (idempotently) a GitHub webhook on the given repo for the scope's
  // connection, so branch-created / PR-merged events are delivered to the app.
  // Space-scoped (org workflows use a free-text repo and set the hook up manually).
  @Post('repos/webhook')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary:
      'Register a GitHub webhook on a repo for the workflow git triggers',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({
    status: 201,
    description: 'Webhook registered (or already present)',
  })
  @ApiResponse({
    status: 403,
    description: 'Token lacks repo-admin (webhook) permission',
  })
  async registerRepoWebhook(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId: string | undefined,
    @Body() body: { repo_full_name?: string },
  ) {
    if (!body.repo_full_name) {
      throw new BadRequestException('repo_full_name is required');
    }

    const data = await this.service.ensureRepoWebhook({
      organizationId: user.organizationId,
      spaceId: spaceId || null,
      repoFullName: body.repo_full_name,
      createdBy: user.userId,
    });

    return { data };
  }
}
