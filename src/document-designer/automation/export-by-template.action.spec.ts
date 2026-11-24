// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (same module-level mocks as
// document-exports.service.spec.ts, which shares the import chain).
jest.mock('../rendering/html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

// This action imports ActionRegistryService, which transitively pulls the common
// rich-text sanitizer (action-registry -> app-mutations/wiki -> wiki-content.util
// -> common/utils/sanitize-rich-text). That module also eagerly loads jsdom, so
// mock it here too — same reason as the html-sanitizer mock above.
jest.mock('../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

// puppeteer 25 is ESM-only — mock it module-level so importing the pdf render
// service (pulled in via document-exports.service) never loads the real package.
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));

import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ActionRegistryService } from '../../automations/actions/action-registry.service';
import type { ExecutionContext } from '../../automations/actions/types';
import type { FileExplorerService } from '../../file-explorer/file-explorer.service';
import type { MailService } from '../../mail/mail.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type {
  DocumentExportsService,
  IDocumentExportResult,
} from '../document-exports.service';
import type { DocumentWikiPushService } from '../document-wiki-push.service';
import { ExportByTemplateAction } from './export-by-template.action';

const TEMPLATE_ID = '4ac500fd-a2b1-4eba-aa35-37e221d8a211';
const FILTER_ID = '9b2f64f0-1c3d-4e5f-8a7b-6c5d4e3f2a1b';
const KIND = 'app.document.export_by_template';

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE_ID,
    destination: 'email',
    scopeMode: 'saved_filter',
    savedFilterId: FILTER_ID,
    format: 'pdf',
    recipients: ['exec@example.com'],
    skipIfEmpty: false,
    ...overrides,
  };
}

function exportResult(
  over: {
    itemCount?: number;
    bufferSize?: number;
    filePath?: string | null;
  } = {},
): IDocumentExportResult {
  return {
    record: {
      id: 'export-1',
      organization_id: 'org-1',
      template_id: TEMPLATE_ID,
      template_name: 'Status Report',
      requested_by: 'user-1',
      source: 'automation',
      automation_run_id: 'run-1',
      format: 'pdf',
      status: 'completed',
      file_path: over.filePath ?? 'org-1/export-1/Status-Report-2026-07-19.pdf',
      file_size_bytes: over.bufferSize ?? 1024,
      item_count: over.itemCount ?? 3,
      error: null,
      filter_snapshot: { savedFilterId: FILTER_ID },
      started_at: null,
      completed_at: null,
      created_at: '2026-07-19T00:00:00Z',
      updated_at: '2026-07-19T00:00:00Z',
    },
    buffer: Buffer.alloc(over.bufferSize ?? 1024, 1),
    fileName: 'Status-Report-2026-07-19.pdf',
    mimeType: 'application/pdf',
    warnings: [],
  };
}

describe('ExportByTemplateAction', () => {
  let registry: { register: jest.Mock };
  let exportsService: { export: jest.Mock };
  let wikiPush: {
    pushToWiki: jest.Mock;
    updateWikiPush: jest.Mock;
  };
  let fileExplorer: { uploadNewFile: jest.Mock };
  let permissionsService: { resolveSpaceBaseGrant: jest.Mock };
  let mail: { sendWithAttachments: jest.Mock };
  let configGet: jest.Mock;
  let createSignedUrl: jest.Mock;
  let action: ExportByTemplateAction;

  /** Full-grant admin response — most tests aren't exercising permission denial. */
  function adminGrant() {
    return {
      isAdmin: true,
      isMember: true,
      spaceRole: null,
      explicit: {},
      basePermissions: {},
    };
  }

  beforeEach(() => {
    registry = { register: jest.fn() };
    exportsService = { export: jest.fn().mockResolvedValue(exportResult()) };
    wikiPush = {
      pushToWiki: jest.fn().mockResolvedValue({
        page: { id: 'page-1' },
        warnings: [],
      }),
      updateWikiPush: jest.fn().mockResolvedValue({
        page: { id: 'page-1' },
        warnings: [],
      }),
    };
    fileExplorer = {
      uploadNewFile: jest.fn().mockResolvedValue({ id: 'file-node-1' }),
    };
    permissionsService = {
      resolveSpaceBaseGrant: jest.fn().mockResolvedValue(adminGrant()),
    };
    mail = { sendWithAttachments: jest.fn().mockResolvedValue(undefined) };
    configGet = jest.fn().mockReturnValue(undefined);
    createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed.example/document-exports/file' },
      error: null,
    });

    const supa = {
      getClient: () => ({
        storage: { from: jest.fn(() => ({ createSignedUrl })) },
      }),
    } as unknown as SupabaseAdminService;

    action = new ExportByTemplateAction(
      registry as unknown as ActionRegistryService,
      exportsService as unknown as DocumentExportsService,
      wikiPush as unknown as DocumentWikiPushService,
      fileExplorer as unknown as FileExplorerService,
      permissionsService as unknown as PermissionsService,
      mail as unknown as MailService,
      { get: configGet } as unknown as ConfigService,
      supa,
    );
  });

  function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
    const usersTable = {
      select: () => usersTable,
      eq: () => usersTable,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };

    return {
      runId: 'run-1',
      automationId: 'auto-1',
      spaceId: 'space-1',
      organizationId: 'org-1',
      triggerKind: 'app.task.created',
      triggerPayload: {},
      previousStepOutputs: {},
      resolveConnection: jest.fn(),
      step: { sleep: jest.fn(), run: jest.fn() },
      supabase: {
        from: jest.fn(() => usersTable),
      } as unknown as ExecutionContext['supabase'],
      actingUserId: 'user-1',
      logger: { info: jest.fn(), error: jest.fn() },
      ...over,
    } as ExecutionContext;
  }

  it('registers the action definition on module init', () => {
    action.onModuleInit();

    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: KIND,
        category: 'app_mutation',
        type: 'action',
        icon: 'bx-export',
      }),
    );
  });

  describe('handler — attachment delivery (happy path)', () => {
    it('exports with store delivery + automation source and emails the buffer', async () => {
      const def = action.buildDefinition();
      const out = await def.handler(validConfig(), {}, ctx());

      expect(exportsService.export).toHaveBeenCalledWith({
        organizationId: 'org-1',
        userId: 'user-1',
        templateId: TEMPLATE_ID,
        format: 'pdf',
        scope: { savedFilterId: FILTER_ID },
        delivery: 'store',
        source: 'automation',
        automationRunId: 'run-1',
        fileName: undefined,
        // saved_filter scope is list-shaped, so the template's items filter stands
        ignoreItemsRegionFilter: false,
      });

      expect(mail.sendWithAttachments).toHaveBeenCalledTimes(1);
      const calls = mail.sendWithAttachments.mock.calls as {
        to: string[];
        subject: string;
        html: string;
        attachments: { filename: string; contentType: string }[];
      }[][];
      const call = calls[0][0];
      expect(call.to).toEqual(['exec@example.com']);
      expect(call.subject).toBe('Document export: Status Report');
      expect(call.attachments).toHaveLength(1);
      expect(call.attachments[0].filename).toBe('Status-Report-2026-07-19.pdf');
      expect(call.attachments[0].contentType).toBe('application/pdf');

      expect(out).toEqual({
        ok: true,
        exportId: 'export-1',
        itemCount: 3,
        delivered: 'attachment',
      });
    });

    it('resolves {{template}}/{{date}}/{{count}} in subject, message, and fileNamePattern', async () => {
      const def = action.buildDefinition();
      await def.handler(
        validConfig({
          subject: '{{template}} — {{count}} items',
          message: 'Report for {{template}} on {{date}}\nSecond line',
          fileNamePattern: 'Weekly-{{template}}-{{count}}',
        }),
        {},
        ctx(),
      );

      const calls = mail.sendWithAttachments.mock.calls as {
        subject: string;
        html: string;
        attachments: { filename: string }[];
      }[][];
      const call = calls[0][0];
      expect(call.subject).toBe('Status Report — 3 items');
      expect(call.html).toContain('Report for Status Report on');
      // Newlines in the message become <br> in the HTML body.
      expect(call.html).toContain('<br>Second line');
      // sanitizeFileName collapses whitespace to '-'; format extension appended.
      expect(call.attachments[0].filename).toBe('Weekly-Status-Report-3.pdf');
    });
  });

  describe('handler — oversized export', () => {
    it('emails a 7-day signed link instead of an attachment', async () => {
      configGet.mockImplementation((key: string) =>
        key === 'DOCUMENT_EMAIL_ATTACHMENT_MAX_BYTES' ? '512' : undefined,
      );
      exportsService.export.mockResolvedValue(
        exportResult({ bufferSize: 1024 }),
      );

      const def = action.buildDefinition();
      const out = await def.handler(validConfig(), {}, ctx());

      expect(createSignedUrl).toHaveBeenCalledWith(
        'org-1/export-1/Status-Report-2026-07-19.pdf',
        604_800,
      );
      expect(mail.sendWithAttachments).toHaveBeenCalledTimes(1);
      const calls = mail.sendWithAttachments.mock.calls as {
        html: string;
        attachments: unknown[];
      }[][];
      const call = calls[0][0];
      expect(call.attachments).toEqual([]);
      expect(call.html).toContain(
        'https://signed.example/document-exports/file',
      );

      expect(out).toEqual(
        expect.objectContaining({ ok: true, delivered: 'link' }),
      );
    });
  });

  describe('handler — skipIfEmpty', () => {
    it('skips the email (but still exports/stores) when 0 items match', async () => {
      exportsService.export.mockResolvedValue(exportResult({ itemCount: 0 }));

      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({ skipIfEmpty: true }),
        {},
        ctx(),
      );

      expect(exportsService.export).toHaveBeenCalledTimes(1);
      expect(mail.sendWithAttachments).not.toHaveBeenCalled();
      expect(out).toEqual({
        ok: true,
        exportId: 'export-1',
        itemCount: 0,
        delivered: 'skipped',
      });
    });

    it('still emails an empty document when skipIfEmpty is false', async () => {
      exportsService.export.mockResolvedValue(exportResult({ itemCount: 0 }));

      const def = action.buildDefinition();
      const out = await def.handler(validConfig(), {}, ctx());

      expect(mail.sendWithAttachments).toHaveBeenCalledTimes(1);
      expect(out).toEqual(
        expect.objectContaining({ itemCount: 0, delivered: 'attachment' }),
      );
    });
  });

  describe('handler — acting user', () => {
    it('throws an actionable error when ctx.actingUserId is null', async () => {
      const def = action.buildDefinition();

      await expect(
        def.handler(validConfig(), {}, ctx({ actingUserId: null })),
      ).rejects.toThrow(
        'Export by Template requires an acting user; configure a service user for this automation',
      );
      expect(exportsService.export).not.toHaveBeenCalled();
      expect(mail.sendWithAttachments).not.toHaveBeenCalled();
    });
  });

  describe('handler — recipients: dynamic UUID lookup', () => {
    const USER_UUID = '3f2b1a4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

    it('resolves a UUID recipient to that user email and sends to both static + dynamic recipients', async () => {
      const usersTable = {
        select: () => usersTable,
        eq: () => usersTable,
        maybeSingle: () =>
          Promise.resolve({
            data: { email: 'assignee@example.com' },
            error: null,
          }),
      };
      const supabase = {
        from: jest.fn(() => usersTable),
      } as unknown as ExecutionContext['supabase'];

      const def = action.buildDefinition();
      await def.handler(
        validConfig({ recipients: ['exec@example.com', USER_UUID] }),
        {},
        ctx({ supabase }),
      );

      expect(mail.sendWithAttachments).toHaveBeenCalledTimes(1);
      const calls = mail.sendWithAttachments.mock.calls as {
        to: string[];
      }[][];
      expect(calls[0][0].to).toEqual([
        'exec@example.com',
        'assignee@example.com',
      ]);
    });

    it('skips a UUID recipient with no resolvable email, and skips delivery entirely when nothing resolves', async () => {
      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({ recipients: [USER_UUID] }),
        {},
        ctx(), // default ctx() users-table mock returns { data: null }
      );

      expect(mail.sendWithAttachments).not.toHaveBeenCalled();
      expect(out).toEqual(expect.objectContaining({ delivered: 'skipped' }));
    });

    it('skips a recipient entry that is still an unresolved {{ }} placeholder', async () => {
      const def = action.buildDefinition();
      await def.handler(
        validConfig({
          recipients: ['exec@example.com', '{{ trigger.task.assigned_to }}'],
        }),
        {},
        ctx(),
      );

      const calls = mail.sendWithAttachments.mock.calls as {
        to: string[];
      }[][];
      expect(calls[0][0].to).toEqual(['exec@example.com']);
    });
  });

  describe('handler — scope: entity_ids', () => {
    it('bypasses the template items-region filter so the named record cannot be filtered out', async () => {
      const def = action.buildDefinition();
      await def.handler(
        validConfig({
          scopeMode: 'entity_ids',
          entityIds: ['task-123'],
          savedFilterId: undefined,
        }),
        {},
        ctx(),
      );

      expect(exportsService.export).toHaveBeenCalledWith(
        expect.objectContaining({ ignoreItemsRegionFilter: true }),
      );
    });

    it('passes resolved entity ids through as scope.ids', async () => {
      const def = action.buildDefinition();
      await def.handler(
        validConfig({
          scopeMode: 'entity_ids',
          entityIds: ['task-123'],
          savedFilterId: undefined,
        }),
        {},
        ctx(),
      );

      expect(exportsService.export).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { ids: ['task-123'] } }),
      );
    });

    it('treats an entityIds list that is all unresolved {{ }} tokens as zero items — never calls export() with an empty ids array', async () => {
      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({
          scopeMode: 'entity_ids',
          entityIds: ['{{ trigger.task.id }}'],
          savedFilterId: undefined,
          skipIfEmpty: true,
        }),
        {},
        ctx(),
      );

      expect(exportsService.export).not.toHaveBeenCalled();
      expect(out).toEqual(
        expect.objectContaining({ delivered: 'skipped', itemCount: 0 }),
      );
    });

    it('fails loud (not silently) when entityIds resolves empty and skipIfEmpty is false', async () => {
      const def = action.buildDefinition();

      await expect(
        def.handler(
          validConfig({
            scopeMode: 'entity_ids',
            entityIds: ['{{ trigger.task.id }}'],
            savedFilterId: undefined,
            skipIfEmpty: false,
          }),
          {},
          ctx(),
        ),
      ).rejects.toThrow(/entityIds resolved to no valid ids/);
      expect(exportsService.export).not.toHaveBeenCalled();
    });
  });

  describe('handler — destination: save_as_file', () => {
    it('uploads the rendered buffer to File Explorer with a synthetic user and a run-id-suffixed filename', async () => {
      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({ destination: 'save_as_file' }),
        {},
        ctx(),
      );

      expect(permissionsService.resolveSpaceBaseGrant).toHaveBeenCalledWith(
        'user-1',
        'org-1',
        'space-1',
      );
      expect(fileExplorer.uploadNewFile).toHaveBeenCalledTimes(1);
      const [user, spaceId, dto, file] = fileExplorer.uploadNewFile.mock
        .calls[0] as [
        { userId: string; organizationId: string },
        string,
        { space_id: string; parent_id: string | undefined },
        { originalname: string; buffer: Buffer },
      ];
      expect(user.userId).toBe('user-1');
      expect(user.organizationId).toBe('org-1');
      expect(spaceId).toBe('space-1');
      expect(dto.space_id).toBe('space-1');
      expect(file.originalname).toMatch(
        /^Status-Report-\d{4}-\d{2}-\d{2}-[\w-]+\.pdf$/,
      );
      expect(mail.sendWithAttachments).not.toHaveBeenCalled();
      expect(out).toEqual(
        expect.objectContaining({
          delivered: 'uploaded',
          fileNodeId: 'file-node-1',
        }),
      );
    });

    it('throws a permission error (and never uploads) when the acting user lacks create_file_explorer', async () => {
      permissionsService.resolveSpaceBaseGrant.mockResolvedValue({
        isAdmin: false,
        isMember: true,
        spaceRole: 'member',
        explicit: {},
        basePermissions: {},
      });

      const def = action.buildDefinition();

      await expect(
        def.handler(validConfig({ destination: 'save_as_file' }), {}, ctx()),
      ).rejects.toThrow(/create_file_explorer/);
      expect(fileExplorer.uploadNewFile).not.toHaveBeenCalled();
      // Permission is checked BEFORE the (expensive) render/export call, not after.
      expect(exportsService.export).not.toHaveBeenCalled();
    });
  });

  describe('handler — destination: create_wiki_page', () => {
    function wikiCtx(over: Partial<ExecutionContext> = {}) {
      const supabase = {
        from: jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          // resolveSpaceKey's .maybeSingle() call — spaceKey resolves to null,
          // which the action already handles (fileUrl/pageUrl just stay null).
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          // No prior push recorded by default — resolves to { data: [] }.
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [], error: null }),
        })),
      } as unknown as ExecutionContext['supabase'];

      return ctx({ supabase, ...over });
    }

    it('creates a new wiki page via pushToWiki when no prior push matches this scope', async () => {
      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({ destination: 'create_wiki_page', format: undefined }),
        {},
        wikiCtx(),
      );

      expect(wikiPush.pushToWiki).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          templateId: TEMPLATE_ID,
          spaceId: 'space-1',
        }),
      );
      expect(wikiPush.updateWikiPush).not.toHaveBeenCalled();
      expect(out).toEqual(
        expect.objectContaining({
          delivered: 'wiki_created',
          pageId: 'page-1',
        }),
      );
    });

    it('translates a ConflictException (hand-edited page, not confirmed) into a skip rather than a failed run', async () => {
      const supabase = {
        from: jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({
              data: [
                {
                  source_page_id: 'page-1',
                  target_metadata: { scope: { savedFilterId: FILTER_ID } },
                  wiki_pages: {
                    space_id: 'space-1',
                    organization_id: 'org-1',
                  },
                },
              ],
              error: null,
            }),
        })),
      } as unknown as ExecutionContext['supabase'];

      wikiPush.updateWikiPush.mockRejectedValue(
        new ConflictException('This page was edited since the last push'),
      );

      const def = action.buildDefinition();
      const out = await def.handler(
        validConfig({ destination: 'create_wiki_page', format: undefined }),
        {},
        ctx({ supabase }),
      );

      expect(wikiPush.updateWikiPush).toHaveBeenCalledTimes(1);
      expect(out).toEqual(expect.objectContaining({ delivered: 'skipped' }));
    });
  });

  describe('configSchema', () => {
    it('accepts a valid config and defaults skipIfEmpty to false', () => {
      const def = action.buildDefinition();
      const parsed = def.configSchema.safeParse({
        templateId: TEMPLATE_ID,
        savedFilterId: FILTER_ID,
        format: 'docx',
        recipients: ['a@example.com'],
      });

      expect(parsed.success).toBe(true);
      expect(
        (parsed as { data: { skipIfEmpty: boolean } }).data.skipIfEmpty,
      ).toBe(false);
    });

    it('accepts a non-email-shaped recipient at the schema layer (validated at execute-time instead)', () => {
      // recipients intentionally does NOT enforce email format here — a
      // {{ trigger.task.assigned_to }} placeholder resolves to a users.id
      // UUID before this schema ever runs, and that must be schema-valid so
      // resolveRecipients() gets a chance to look up the email at execute
      // time. See the 'handler — recipients: dynamic UUID lookup' block.
      const def = action.buildDefinition();

      expect(
        def.configSchema.safeParse(
          validConfig({ recipients: ['not-an-email'] }),
        ).success,
      ).toBe(true);
    });

    it('rejects more than 20 recipients', () => {
      const def = action.buildDefinition();
      const recipients = Array.from(
        { length: 21 },
        (_, i) => `user${i}@example.com`,
      );

      expect(
        def.configSchema.safeParse(validConfig({ recipients })).success,
      ).toBe(false);
    });

    it('rejects a missing templateId', () => {
      const def = action.buildDefinition();
      const config = validConfig() as Record<string, unknown>;
      delete config.templateId;

      expect(def.configSchema.safeParse(config).success).toBe(false);
    });
  });
});
