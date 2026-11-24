/* eslint-disable @typescript-eslint/unbound-method */
// (jest mock assertions on class methods are a known unbound-method false
// positive — same disable used by users/workflow-engine controller specs)

// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./rendering/html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { BindableFieldsService } from './bindable-fields.service';
import type { DocumentTemplateRepository } from './document-template.repository';
import type { DocumentTemplateVersionsService } from './document-template-versions.service';
import { DocumentTemplatesService } from './document-templates.service';
import type { DocumentDataResolverService } from './rendering/document-data-resolver.service';
import type { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import type { DocumentRenderService } from './rendering/document-render.service';
import { findStarterTemplate } from './starter-templates.catalog';
import type { IDocumentTemplate } from './template-definition/template-definition.types';

const ORG = 'org-1';
const USER = 'user-1';

function validDefinition(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'repeat_per_item',
    sourceEntity: 'tasks',
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
      pageBreakMargin: 24,
    },
    elements: [
      {
        id: 'text-1',
        type: 'text',
        html: '<p>{{summary}}</p>',
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        rotation: 0,
        positionMode: 'absolute',
        zIndex: 0,
        style: {},
      },
    ],
    ...overrides,
  };
}

function templateRow(
  overrides: Partial<IDocumentTemplate> = {},
): IDocumentTemplate {
  return {
    id: 'template-1',
    organization_id: ORG,
    name: 'Status Report',
    description: null,
    source_entity: 'tasks',
    mode: 'repeat_per_item',
    definition: validDefinition() as unknown as IDocumentTemplate['definition'],
    is_archived: false,
    created_by: USER,
    updated_by: USER,
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:00Z',
    ...overrides,
  };
}

describe('DocumentTemplatesService', () => {
  let templateRepo: jest.Mocked<DocumentTemplateRepository>;
  let bindableFields: jest.Mocked<BindableFieldsService>;
  let dataResolver: jest.Mocked<DocumentDataResolverService>;
  let renderService: jest.Mocked<DocumentRenderService>;
  let auditLogs: jest.Mocked<AuditLogsService>;
  let imageResolver: jest.Mocked<DocumentImageResolverService>;
  let supabaseAdmin: jest.Mocked<SupabaseAdminService>;
  let versionsService: jest.Mocked<DocumentTemplateVersionsService>;
  let service: DocumentTemplatesService;

  beforeEach(() => {
    templateRepo = {
      findById: jest.fn(),
      findByOrganization: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      duplicate: jest.fn(),
    } as unknown as jest.Mocked<DocumentTemplateRepository>;
    bindableFields = {
      getBindableFields: jest.fn(),
    } as unknown as jest.Mocked<BindableFieldsService>;
    dataResolver = {
      resolve: jest.fn(),
    } as unknown as jest.Mocked<DocumentDataResolverService>;
    renderService = {
      render: jest.fn(),
    } as unknown as jest.Mocked<DocumentRenderService>;
    auditLogs = {
      logAction: jest.fn(),
    } as unknown as jest.Mocked<AuditLogsService>;
    imageResolver = {
      prepareImages: jest
        .fn()
        .mockImplementation((_orgId: string, definition: unknown) =>
          Promise.resolve({ definition, resolveImageSrc: () => '' }),
        ),
    } as unknown as jest.Mocked<DocumentImageResolverService>;
    supabaseAdmin = {
      getClient: jest.fn(),
    } as unknown as jest.Mocked<SupabaseAdminService>;
    versionsService = {
      captureVersion: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<DocumentTemplateVersionsService>;

    service = new DocumentTemplatesService(
      templateRepo,
      bindableFields,
      dataResolver,
      renderService,
      auditLogs,
      imageResolver,
      supabaseAdmin,
      versionsService,
    );
  });

  describe('list', () => {
    it('maps the repository totalCount to the { data, count } wire shape', async () => {
      templateRepo.findByOrganization.mockResolvedValue({
        data: [templateRow()],
        totalCount: 42,
      });

      const result = await service.list(ORG, { page: 1 });

      expect(templateRepo.findByOrganization).toHaveBeenCalledWith(ORG, {
        page: 1,
      });
      expect(result.count).toBe(42);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('creates a template with a valid definition and logs an audit entry', async () => {
      templateRepo.create.mockResolvedValue(templateRow());

      const result = await service.create(ORG, USER, {
        name: 'Status Report',
        source_entity: 'tasks',
        mode: 'repeat_per_item',
        definition: validDefinition(),
      });

      expect(templateRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG,
          name: 'Status Report',
          source_entity: 'tasks',
          mode: 'repeat_per_item',
          created_by: USER,
          updated_by: USER,
        }),
      );
      expect(auditLogs.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'document_template',
        'template-1',
        'create',
        expect.any(Object),
      );
      expect(result.id).toBe('template-1');
    });

    it('rejects an invalid definition with a readable message', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'Bad',
          source_entity: 'tasks',
          mode: 'repeat_per_item',
          definition: { schemaVersion: 1 },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(templateRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a source_entity mismatch with the definition', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'Mismatch',
          source_entity: 'processes',
          mode: 'repeat_per_item',
          definition: validDefinition(), // sourceEntity: 'tasks'
        }),
      ).rejects.toThrow(/source_entity 'processes' does not match/);
    });

    it('rejects a mode mismatch with the definition', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'Mismatch',
          source_entity: 'tasks',
          mode: 'fixed_document',
          definition: validDefinition(), // mode: 'repeat_per_item'
        }),
      ).rejects.toThrow(/mode 'fixed_document' does not match/);
    });

    it('rejects storage image sources outside the allowed buckets / org folder', async () => {
      const foreignImage = {
        id: 'img-1',
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
        positionMode: 'absolute',
        zIndex: 0,
        style: {},
        objectFit: 'contain',
        src: {
          kind: 'storage',
          bucket: 'attachments',
          path: 'other-org/confidential.png',
        },
      };

      await expect(
        service.create(ORG, USER, {
          name: 'Leaky',
          source_entity: 'tasks',
          mode: 'repeat_per_item',
          definition: validDefinition({
            elements: [foreignImage],
          }),
        }),
      ).rejects.toThrow(/allowed buckets/);
      expect(templateRepo.create).not.toHaveBeenCalled();
    });

    it('accepts storage image sources inside the org folder of an allowed bucket', async () => {
      templateRepo.create.mockResolvedValue(templateRow());

      const ownImage = {
        id: 'img-1',
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
        positionMode: 'absolute',
        zIndex: 0,
        style: {},
        objectFit: 'contain',
        src: {
          kind: 'storage',
          bucket: 'attachments',
          path: `${ORG}/logo.png`,
        },
      };

      await expect(
        service.create(ORG, USER, {
          name: 'Branded',
          source_entity: 'tasks',
          mode: 'repeat_per_item',
          definition: validDefinition({ elements: [ownImage] }),
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    it('re-validates the definition when present and stamps updated_by', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());
      templateRepo.update.mockResolvedValue(templateRow({ name: 'Renamed' }));

      await service.update(ORG, USER, 'template-1', {
        name: 'Renamed',
        definition: validDefinition(),
      });

      expect(templateRepo.update).toHaveBeenCalledWith(
        ORG,
        'template-1',
        expect.objectContaining({ name: 'Renamed', updated_by: USER }),
      );
    });

    it('rejects a mode change that contradicts the stored definition', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());

      await expect(
        service.update(ORG, USER, 'template-1', { mode: 'fixed_document' }),
      ).rejects.toThrow(/does not match definition.mode/);
      expect(templateRepo.update).not.toHaveBeenCalled();
    });

    it('syncs the mode column from definition.mode on full-definition saves', async () => {
      templateRepo.findById.mockResolvedValue(
        templateRow(), // stored row: mode 'repeat_per_item'
      );
      templateRepo.update.mockResolvedValue(
        templateRow({ mode: 'fixed_document' }),
      );

      // The editor changes definition.mode without sending dto.mode.
      await service.update(ORG, USER, 'template-1', {
        definition: validDefinition({ mode: 'fixed_document' }),
      });

      expect(templateRepo.update).toHaveBeenCalledWith(
        ORG,
        'template-1',
        expect.objectContaining({ mode: 'fixed_document' }),
      );
    });

    it('still rejects an explicit dto.mode that contradicts the new definition', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());

      await expect(
        service.update(ORG, USER, 'template-1', {
          mode: 'repeat_per_item',
          definition: validDefinition({ mode: 'fixed_document' }),
        }),
      ).rejects.toThrow(/does not match definition.mode/);
      expect(templateRepo.update).not.toHaveBeenCalled();
    });

    it('rejects updates whose definition references a foreign storage image', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());

      await expect(
        service.update(ORG, USER, 'template-1', {
          definition: validDefinition({
            elements: [
              {
                id: 'img-1',
                type: 'image',
                x: 0,
                y: 0,
                width: 100,
                height: 50,
                rotation: 0,
                positionMode: 'absolute',
                zIndex: 0,
                style: {},
                objectFit: 'contain',
                src: {
                  kind: 'storage',
                  bucket: 'site-studio-assets',
                  path: `${ORG}/logo.png`,
                },
              },
            ],
          }),
        }),
      ).rejects.toThrow(/allowed buckets/);
      expect(templateRepo.update).not.toHaveBeenCalled();
    });

    it('throws NotFound for a template in another organization', async () => {
      templateRepo.findById.mockResolvedValue(null);

      await expect(
        service.update(ORG, USER, 'template-1', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('duplicate', () => {
    it('appends " (Copy)" and truncates to 200 characters', async () => {
      const longName = 'N'.repeat(198);
      templateRepo.findById.mockResolvedValue(templateRow({ name: longName }));
      templateRepo.duplicate.mockResolvedValue(templateRow({ id: 'copy-1' }));

      await service.duplicate(ORG, USER, 'template-1', {});

      const expectedName = `${longName} (Copy)`.slice(0, 200);
      expect(expectedName).toHaveLength(200);
      expect(templateRepo.duplicate).toHaveBeenCalledWith(
        ORG,
        'template-1',
        expectedName,
        USER,
      );
    });

    it('uses the provided name when given', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());
      templateRepo.duplicate.mockResolvedValue(templateRow({ id: 'copy-1' }));

      await service.duplicate(ORG, USER, 'template-1', { name: 'My Copy' });

      expect(templateRepo.duplicate).toHaveBeenCalledWith(
        ORG,
        'template-1',
        'My Copy',
        USER,
      );
    });
  });

  describe('getStarterTemplates', () => {
    it('returns catalog summaries without the definition field', () => {
      const summaries = service.getStarterTemplates();

      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary).not.toHaveProperty('definition');
      }
    });
  });

  describe('createFromStarter', () => {
    it('creates from a known starter key using the catalog name/description/source_entity/mode/definition', async () => {
      templateRepo.findByOrganization.mockResolvedValue({
        data: [],
        totalCount: 0,
      });
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue(templateRow({ id: 'from-starter-1' }));
      const starter = findStarterTemplate('task-report')!;

      const result = await service.createFromStarter(
        ORG,
        USER,
        'task-report',
        {},
      );

      expect(createSpy).toHaveBeenCalledWith(ORG, USER, {
        name: starter.name,
        description: starter.description,
        source_entity: starter.source_entity,
        mode: starter.mode,
        definition: starter.definition,
      });
      expect(result.id).toBe('from-starter-1');
    });

    it('throws NotFoundException for an unknown starter key', async () => {
      await expect(
        service.createFromStarter(ORG, USER, 'not-a-real-key', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('uses an explicit dto.name as-is, skipping the collision check', async () => {
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue(templateRow());

      await service.createFromStarter(ORG, USER, 'task-report', {
        name: 'My Custom Name',
      });

      expect(templateRepo.findByOrganization).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ name: 'My Custom Name' }),
      );
    });

    it('appends " (2)" when an omitted name collides with an existing template', async () => {
      templateRepo.findByOrganization.mockResolvedValue({
        data: [templateRow({ name: 'Task Report' })],
        totalCount: 1,
      });
      const createSpy = jest
        .spyOn(service, 'create')
        .mockResolvedValue(templateRow());

      await service.createFromStarter(ORG, USER, 'task-report', {});

      expect(createSpy).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ name: 'Task Report (2)' }),
      );
    });
  });

  describe('preview', () => {
    it('requires a definition for ad-hoc previews', async () => {
      await expect(service.preview(ORG, USER, {})).rejects.toThrow(
        /definition is required/,
      );
    });

    it('resolves data and renders with merged warnings', async () => {
      dataResolver.resolve.mockResolvedValue({
        items: [{ id: 'task-1', entityType: 'task', raw: { id: 'task-1' } }],
        subtasksByItemId: {},
        linkedByItemId: {},
        dynamicQueryByRegionId: {},
        lookups: {
          usersById: {},
          statusesById: {},
          prioritiesById: {},
          spacesById: {},
          assetsById: {},
          tasksById: {},
          wikiPagesById: {},
          organizationName: 'Acme',
        },
        fieldDefsBySpace: {},
        orgFieldDefs: {},
        warnings: ['data warning'],
      });
      renderService.render.mockReturnValue({
        html: '<!DOCTYPE html>…',
        warnings: ['render warning'],
      });

      const result = await service.preview(ORG, USER, {
        definition: validDefinition(),
        itemLimit: 2,
      });

      expect(dataResolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          sourceEntity: 'tasks',
          itemLimit: 2,
          truncateOverLimit: true,
        }),
      );
      expect(result.itemCount).toBe(1);
      expect(result.warnings).toEqual(['data warning', 'render warning']);
    });

    it('previewById loads and re-validates the stored definition', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());
      dataResolver.resolve.mockResolvedValue({
        items: [],
        subtasksByItemId: {},
        linkedByItemId: {},
        dynamicQueryByRegionId: {},
        lookups: {
          usersById: {},
          statusesById: {},
          prioritiesById: {},
          spacesById: {},
          assetsById: {},
          tasksById: {},
          wikiPagesById: {},
          organizationName: 'Acme',
        },
        fieldDefsBySpace: {},
        orgFieldDefs: {},
        warnings: [],
      });
      renderService.render.mockReturnValue({ html: '<html>', warnings: [] });

      const result = await service.previewById(ORG, USER, 'template-1', {});

      expect(templateRepo.findById).toHaveBeenCalledWith(ORG, 'template-1');
      expect(result.itemCount).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes and audit-logs', async () => {
      templateRepo.findById.mockResolvedValue(templateRow());
      templateRepo.delete.mockResolvedValue(undefined);

      const result = await service.delete(ORG, USER, 'template-1');

      expect(templateRepo.delete).toHaveBeenCalledWith(ORG, 'template-1');
      expect(auditLogs.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'document_template',
        'template-1',
        'delete',
        expect.any(Object),
      );
      expect(result).toEqual({ success: true });
    });
  });
});
