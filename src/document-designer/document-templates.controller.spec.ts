/* eslint-disable @typescript-eslint/unbound-method */
// (jest mock assertions on class methods are a known unbound-method false
// positive — same disable used by users/workflow-engine controller specs)

// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./rendering/html-sanitizer', () => ({
  sanitizeHtml: (html: string) => html,
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

import 'reflect-metadata';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { REQUIRE_FEATURE_KEY } from '../auth/decorators/require-feature.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/require-permissions.decorator';
import { DocumentTemplatesController } from './document-templates.controller';
import type { DocumentTemplatesService } from './document-templates.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

runControllerContractSuite({
  controller: DocumentTemplatesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('DocumentTemplatesController manual behavior', () => {
  let controller: DocumentTemplatesController;
  let service: jest.Mocked<DocumentTemplatesService>;

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
  } as RequestUser;

  beforeEach(() => {
    service = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      duplicate: jest.fn(),
      getBindableFields: jest.fn(),
      preview: jest.fn(),
      previewById: jest.fn(),
      getStarterTemplates: jest.fn(),
      createFromStarter: jest.fn(),
    } as unknown as jest.Mocked<DocumentTemplatesService>;
    controller = new DocumentTemplatesController(service);
  });

  it('requires the document designer feature at class level', () => {
    expect(
      Reflect.getMetadata(REQUIRE_FEATURE_KEY, DocumentTemplatesController),
    ).toEqual(['module_document_designer']);
  });

  it('applies view/manage permissions per route', () => {
    const proto = DocumentTemplatesController.prototype;
    const permissionsOf = (handler: unknown) =>
      Reflect.getMetadata(PERMISSIONS_KEY, handler as object) as {
        permissions: string[];
      };

    expect(permissionsOf(proto.list).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.getBindableFields).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.getStarterTemplates).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.useStarterTemplate).permissions).toEqual([
      'can_manage_document_templates',
    ]);
    expect(permissionsOf(proto.getById).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.preview).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.previewById).permissions).toEqual([
      'can_view_document_templates',
    ]);
    expect(permissionsOf(proto.create).permissions).toEqual([
      'can_manage_document_templates',
    ]);
    expect(permissionsOf(proto.update).permissions).toEqual([
      'can_manage_document_templates',
    ]);
    expect(permissionsOf(proto.remove).permissions).toEqual([
      'can_manage_document_templates',
    ]);
    expect(permissionsOf(proto.duplicate).permissions).toEqual([
      'can_manage_document_templates',
    ]);
  });

  it('lists templates with normalized query filters', async () => {
    await controller.list(user, 'Report', 'tasks', true, 2, 25);

    expect(service.list).toHaveBeenCalledWith('org-1', {
      search: 'Report',
      source_entity: 'tasks',
      include_archived: true,
      page: 2,
      pageSize: 25,
    });
  });

  it('parses comma-separated space_ids for bindable fields', async () => {
    await controller.getBindableFields(user, 'tasks', 'space-1, space-2');

    expect(service.getBindableFields).toHaveBeenCalledWith('org-1', 'tasks', [
      'space-1',
      'space-2',
    ]);
  });

  it('omits space_ids when the query param is absent', async () => {
    await controller.getBindableFields(user, 'processes', undefined);

    expect(service.getBindableFields).toHaveBeenCalledWith(
      'org-1',
      'processes',
      undefined,
    );
  });

  it('creates templates with organization and user context', async () => {
    const dto = {
      name: 'Report',
      source_entity: 'tasks' as const,
      mode: 'repeat_per_item' as const,
      definition: {},
    };

    await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('delegates the starter template catalog routes', async () => {
    controller.getStarterTemplates();
    await controller.useStarterTemplate(user, 'task-report', { name: 'Copy' });

    expect(service.getStarterTemplates).toHaveBeenCalledWith();
    expect(service.createFromStarter).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'task-report',
      { name: 'Copy' },
    );
  });

  it('delegates preview endpoints', async () => {
    const dto = { definition: {}, itemLimit: 2 };
    await controller.preview(user, dto);
    await controller.previewById(user, 'template-1', dto);

    expect(service.preview).toHaveBeenCalledWith('org-1', 'user-1', dto);
    expect(service.previewById).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'template-1',
      dto,
    );
  });

  it('delegates update, delete, and duplicate with route identifiers', async () => {
    await controller.update(user, 'template-1', { name: 'Renamed' });
    await controller.remove(user, 'template-1');
    await controller.duplicate(user, 'template-1', { name: 'Copy' });

    expect(service.update).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'template-1',
      {
        name: 'Renamed',
      },
    );
    expect(service.delete).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'template-1',
    );
    expect(service.duplicate).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'template-1',
      { name: 'Copy' },
    );
  });
});
