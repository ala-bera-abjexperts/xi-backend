/**
 * @fileoverview Permission guard for the chat and Robert routes (XE-T353, ADM-08).
 *
 * The shared PermissionsGuard is deliberately NOT used here:
 *  - it lets a handler-level key replace the class-level key;
 *  - it falls back to free-form `space_members.permissions` when a `spaceId` arrives
 *    in the request, so a space manager could grant themselves any key.
 * This guard reads ORGANIZATION-level permissions only and requires the class key AND
 * the handler key together. Nothing from query, params or body is ever read.
 * @module src/chat/chat-permission.guard
 */

import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';

/** The organization-level keys of chat and Robert (IPermissionsObject). */
export const CHAT_PERMISSION_KEYS = [
  'can_use_chat',
  'can_create_chat_groups',
  'can_delete_any_chat_message',
  'can_use_robert',
  'can_manage_robert',
  'can_view_ai_audit',
] as const;
export type ChatPermissionKey = (typeof CHAT_PERMISSION_KEYS)[number];

/** Metadata key read by {@link ChatPermissionGuard}. */
export const CHAT_PERMISSION_KEY = 'chatPermission';

@Injectable()
export class ChatPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * @throws ForbiddenException when the caller lacks the class key or the handler key
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // getAll, not getAllAndOverride: the handler key adds to the class key.
    const keys = this.reflector
      .getAll<
        (ChatPermissionKey | undefined)[]
      >(CHAT_PERMISSION_KEY, [context.getClass(), context.getHandler()])
      .filter((key): key is ChatPermissionKey => !!key);

    const { user } = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();

    if (!user) throw new ForbiddenException('No user context found');

    const allowed = await this.permissionsService.hasAllPermissions(
      user.userId,
      user.organizationId,
      keys,
    );

    if (!allowed) throw new ForbiddenException('Insufficient permissions');

    return true;
  }
}

/**
 * Requires an organization-level chat permission on a controller or a handler. It
 * attaches {@link ChatPermissionGuard} itself, so the key can never be left unenforced.
 *
 * @example
 * @RequireChatPermission('can_use_chat')
 * @Controller('chat')
 * export class ChatConversationsController {}
 */
export const RequireChatPermission = (key: ChatPermissionKey) =>
  applyDecorators(
    SetMetadata(CHAT_PERMISSION_KEY, key),
    UseGuards(ChatPermissionGuard),
  );
