/**
 * @fileoverview Route metadata of EVERY controller under src/chat (found on disk, so
 * a new controller is covered without touching this file):
 *  - the class is gated by `can_use_chat` (ADM-08);
 *  - every handler that changes something is closed during impersonation (SEC-12).
 * @module src/chat/chat-controllers.spec
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
// Not re-exported from the `@nestjs/common` root barrel in the pinned NestJS.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IMPERSONATION_BLOCKED_KEY } from '../auth/decorators/impersonation-blocked.decorator';
import { CHAT_PERMISSION_KEY } from './chat-permission.guard';

// jsdom-backed DOMPurify is ESM; the real sanitiser has its own spec.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(),
}));

/**
 * The only handlers that are not GET and still answer during impersonation,
 * because they read and change nothing (contract 3.6).
 */
const READ_ONLY_POSTS = ['POST refs/resolve', 'POST users/availability'];

type Controller = { name: string; prototype: Record<string, object> };

const controllers = (readdirSync(__dirname, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.controller.ts'))
  .flatMap((file) =>
    Object.values(
      jest.requireActual<Record<string, unknown>>(join(__dirname, file)),
    ),
  )
  .filter(
    (exported): exported is Controller =>
      typeof exported === 'function' &&
      Reflect.hasMetadata(PATH_METADATA, exported),
  );

const routes = controllers.flatMap((controller) =>
  Object.getOwnPropertyNames(controller.prototype)
    .map((name) => ({ name, handler: controller.prototype[name] }))
    .filter(
      ({ handler }) =>
        typeof handler === 'function' &&
        Reflect.hasMetadata(METHOD_METADATA, handler),
    )
    .map(({ name, handler }) => ({
      id: `${controller.name}.${name}`,
      handler,
      route: `${
        RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
        ]
      } ${Reflect.getMetadata(PATH_METADATA, handler) as string}`,
    })),
);

describe('chat controllers', () => {
  it('finds the controllers and their routes (guards against a vacuous pass)', () => {
    expect(controllers.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'ChatConversationsController',
        'ChatMessagesController',
        'ChatNotificationsController',
      ]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(27);
    expect(routes.map((r) => r.route)).toContain('POST realtime/token');
  });

  it('gates every controller by can_use_chat', () => {
    expect(
      controllers
        .filter(
          (controller) =>
            Reflect.getMetadata(CHAT_PERMISSION_KEY, controller) !==
            'can_use_chat',
        )
        .map((controller) => controller.name),
    ).toEqual([]);
  });

  it('additionally requires can_create_chat_groups to create a group', () => {
    const createGroup = routes.find(({ route }) => route === 'POST groups');

    expect(
      Reflect.getMetadata(CHAT_PERMISSION_KEY, createGroup?.handler ?? {}),
    ).toBe('can_create_chat_groups');
  });

  it('closes every handler that changes something during impersonation', () => {
    // A write-enabled impersonation session passes the read-only guard, so each
    // of these would otherwise act as the impersonated user.
    const open = routes
      .filter(({ route }) => !route.startsWith('GET '))
      .filter(({ route }) => !READ_ONLY_POSTS.includes(route))
      .filter(
        ({ handler }) =>
          Reflect.getMetadata(IMPERSONATION_BLOCKED_KEY, handler) !== true,
      )
      .map(({ id, route }) => `${id} (${route})`);

    expect(open).toEqual([]);
  });

  it.each(['POST refs/resolve', 'POST users/availability'])(
    'keeps %s open during impersonation (it only reads)',
    (path) => {
      const open = routes.find(({ route }) => route === path);

      expect(open).toBeDefined();
      expect(
        Reflect.getMetadata(IMPERSONATION_BLOCKED_KEY, open?.handler ?? {}),
      ).toBeUndefined();
    },
  );

  it('serves the chat settings, and closes only their change during impersonation', () => {
    const blocked = (path: string) =>
      Reflect.getMetadata(
        IMPERSONATION_BLOCKED_KEY,
        routes.find(({ route }) => route === path)?.handler ?? {},
      ) as boolean | undefined;

    expect(routes.map((r) => r.route)).toEqual(
      expect.arrayContaining(['GET settings', 'PATCH settings']),
    );
    expect(blocked('GET settings')).toBeUndefined();
    expect(blocked('PATCH settings')).toBe(true);
  });
});
