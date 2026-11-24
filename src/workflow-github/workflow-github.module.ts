/**
 * @fileoverview NestJS module for the workflow-owned GitHub connection + repo
 * picker. Wires {@link WorkflowGithubController} and {@link WorkflowGithubService}.
 * `SupabaseAdminService` comes from the global `SupabaseModule`; `PermissionsModule`
 * is imported so {@link PermissionsGuard} can resolve `PermissionsService`.
 * This module MUST be registered in `app.module.ts`.
 * @module src/workflow-github/workflow-github.module
 * @author Ala Bera
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { WorkflowGithubController } from './workflow-github.controller';
import { WorkflowGithubService } from './workflow-github.service';

@Module({
  imports: [PermissionsModule],
  controllers: [WorkflowGithubController],
  providers: [WorkflowGithubService],
  exports: [WorkflowGithubService],
})
export class WorkflowGithubModule {}
