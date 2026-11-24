/**
 * @fileoverview Compiles the REAL ChatAgentModule, with every module it imports and
 * every real provider, the way Nest does at start-up. Proves the wiring (each
 * constructor argument resolves, the guards of the controllers resolve) and that the
 * module graph has no import cycle: tasks import attachments, which import chat, so
 * ChatModule must never import ChatAgentModule.
 * Nothing is started: no lifecycle hook runs, no database or provider is contacted,
 * and no .env file is read.
 * @module src/chat-agent/chat-agent.module.spec
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Not re-exported from the `@nestjs/common` root barrel in the pinned NestJS.
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChatAccessService } from '../chat/chat-access.service';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { ChatMessagesService } from '../chat/chat-messages.service';
import { ChatModule } from '../chat/chat.module';
import { ChatPermissionGuard } from '../chat/chat-permission.guard';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
import { ChatRefsService } from '../chat/chat-refs.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AgentActionExecutorService } from './agent-action-executor.service';
import { AgentAuditService } from './agent-audit.service';
import { AgentContextService } from './agent-context.service';
import { AgentGatesService } from './agent-gates.service';
import { AgentResolverService } from './agent-resolver.service';
import { AgentRunStarterService } from './agent-run-starter.service';
import { AgentRunViewService } from './agent-run-view.service';
import { AgentRunWorkerService } from './agent-run-worker.service';
import { AgentRunsRepository } from './agent-runs.repository';
import { AgentSettingsService } from './agent-settings.service';
import { ChatAgentAdminController } from './chat-agent-admin.controller';
import { ChatAgentAuditController } from './chat-agent-audit.controller';
import { ChatAgentRunsController } from './chat-agent-runs.controller';
import { ChatAgentController } from './chat-agent.controller';
import { ChatAgentModule } from './chat-agent.module';

// jsdom-backed DOMPurify is ESM; the real sanitiser has its own spec.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(),
}));

describe('ChatAgentModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        // What AppModule registers globally and the graph below relies on.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        SupabaseModule,
        ChatAgentModule,
      ],
    }).compile();
  }, 120_000);

  afterAll(() => moduleRef?.close());

  it('resolves its controllers and providers', () => {
    for (const token of [
      ChatAgentController,
      ChatAgentAdminController,
      ChatAgentRunsController,
      ChatAgentAuditController,
      AgentGatesService,
      AgentRunsRepository,
      AgentSettingsService,
      AgentContextService,
      AgentRunViewService,
      AgentRunWorkerService,
      AgentRunStarterService,
      AgentResolverService,
      AgentActionExecutorService,
      AgentAuditService,
    ]) {
      expect(moduleRef.get(token, { strict: false })).toBeInstanceOf(token);
    }
  });

  it('finds the chat services it builds on among the exports of ChatModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChatModule)).toEqual(
      expect.arrayContaining([
        ChatAccessService,
        ChatConversationsService,
        ChatMessagesService,
        ChatRealtimeService,
        ChatRefsService,
      ]),
    );
  });

  it('fills the after-send slot of the chat send path with the starter', async () => {
    const messages = moduleRef.get(ChatMessagesService, { strict: false });
    const start = jest
      .spyOn(moduleRef.get(AgentRunStarterService), 'start')
      .mockResolvedValue({ id: 'run-1', messageId: 'a1' });
    const setAfterSend = jest.spyOn(messages, 'setAfterSend');

    moduleRef.get(ChatAgentModule).onModuleInit();
    const [hook] = setAfterSend.mock.calls[0];
    const ctx = {
      user: { userId: 'u1', organizationId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      timezone: 'Europe/Vienna',
    } as unknown as Parameters<typeof hook>[0];

    await expect(hook(ctx)).resolves.toEqual({ id: 'run-1', messageId: 'a1' });
    expect(start).toHaveBeenCalledWith(ctx.user, ctx.conversation, 'm1', {
      timezone: 'Europe/Vienna',
    });

    // A failed start never reaches the send: it answers "no run".
    start.mockRejectedValueOnce(new Error('down'));
    await expect(hook(ctx)).resolves.toBeNull();
  });

  it('can build the permission guard of its controllers', async () => {
    await expect(
      moduleRef.select(ChatAgentModule).resolve(ChatPermissionGuard),
    ).resolves.toBeInstanceOf(ChatPermissionGuard);
  });

  it('is imported by AppModule only (never by ChatModule or anything chat imports)', () => {
    const src = join(__dirname, '..');
    const importers = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => !file.startsWith('chat-agent'))
      .filter((file) =>
        readFileSync(join(src, file), 'utf-8').includes('chat-agent.module'),
      );

    expect(importers).toEqual(['app.module.ts']);
  });
});
