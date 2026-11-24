import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FileExplorerService } from './file-explorer.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';

describe('FileExplorerService softDelete', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  } satisfies RequestUser;

  const activeNode: IFeNode = {
    id: 'node-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    parent_id: null,
    ancestor_ids: [],
    node_type: 'file',
    name: 'Example.pdf',
    description: null,
    mime_type: 'application/pdf',
    file_size: 10,
    current_version_id: 'version-1',
    delete_op_id: null,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  let repo: {
    findNode: jest.Mock;
    findNodeAny: jest.Mock;
    findFileNode: jest.Mock;
    listDescendants: jest.Mock;
    resolveVersion: jest.Mock;
    updateNode: jest.Mock;
  };
  let updateChain: {
    update: jest.Mock;
    in: jest.Mock;
    eq: jest.Mock;
  };
  let from: jest.Mock;
  let auditLogs: { logAction: jest.Mock };
  let access: { resolveEffectivePermission: jest.Mock };
  let storage: { signedViewUrl: jest.Mock };
  let service: FileExplorerService;

  function childNode(overrides: Partial<IFeNode> = {}): IFeNode {
    return {
      ...activeNode,
      id: 'child-1',
      parent_id: activeNode.id,
      ancestor_ids: [activeNode.id],
      name: 'Child.pdf',
      ...overrides,
    };
  }

  beforeEach(() => {
    updateChain = {
      update: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    from = jest.fn().mockReturnValue(updateChain);
    repo = {
      findNode: jest.fn(),
      findNodeAny: jest.fn(),
      findFileNode: jest.fn(),
      listDescendants: jest.fn(),
      resolveVersion: jest.fn(),
      updateNode: jest.fn(),
    };
    auditLogs = { logAction: jest.fn().mockResolvedValue(undefined) };
    storage = { signedViewUrl: jest.fn() };
    access = {
      resolveEffectivePermission: jest.fn().mockResolvedValue({
        canView: true,
        canCreate: false,
        canDelete: true,
      }),
    };

    service = new FileExplorerService(
      { getClient: () => ({ from }) } as never,
      repo as never,
      storage as never,
      auditLogs as never,
      access as never,
      {
        checkUploadAllowed: jest.fn().mockResolvedValue({
          allowed: true,
          quota: 0,
          used: 0,
          remaining: 0,
        }),
      } as never,
    );
  });

  it('returns a signed preview URL for a PDF in the expected space', async () => {
    repo.findFileNode.mockResolvedValue(activeNode);
    repo.resolveVersion.mockResolvedValue({
      id: 'version-1',
      file_path: 'org-1/file-explorer/space-1/node-1/version-1/Example.pdf',
    });
    storage.signedViewUrl.mockResolvedValue('https://signed.example/preview');

    const result = await service.getPreviewInfo(
      user,
      activeNode.id,
      activeNode.space_id,
    );

    expect(result).toEqual({ url: 'https://signed.example/preview' });
    expect(repo.findFileNode).toHaveBeenCalledWith(activeNode.id);
    expect(access.resolveEffectivePermission).toHaveBeenCalledWith(
      user,
      activeNode,
    );
    expect(repo.resolveVersion).toHaveBeenCalledWith(activeNode);
    expect(storage.signedViewUrl).toHaveBeenCalledWith(
      'org-1/file-explorer/space-1/node-1/version-1/Example.pdf',
    );
  });

  it('returns a signed preview URL for parameterized PDF MIME values', async () => {
    repo.findFileNode.mockResolvedValue({
      ...activeNode,
      mime_type: 'APPLICATION/PDF; charset=binary',
    });
    repo.resolveVersion.mockResolvedValue({
      id: 'version-1',
      file_path: 'org-1/file-explorer/space-1/node-1/version-1/Example.pdf',
    });
    storage.signedViewUrl.mockResolvedValue('https://signed.example/preview');

    const result = await service.getPreviewInfo(
      user,
      activeNode.id,
      activeNode.space_id,
    );

    expect(result).toEqual({ url: 'https://signed.example/preview' });
    expect(repo.resolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ mime_type: 'APPLICATION/PDF; charset=binary' }),
    );
  });

  it('returns a signed preview URL for PDF filenames when MIME metadata is missing', async () => {
    repo.findFileNode.mockResolvedValue({
      ...activeNode,
      mime_type: null,
      name: 'Fallback.PDF',
    });
    repo.resolveVersion.mockResolvedValue({
      id: 'version-1',
      file_path: 'org-1/file-explorer/space-1/node-1/version-1/Fallback.PDF',
    });
    storage.signedViewUrl.mockResolvedValue('https://signed.example/preview');

    const result = await service.getPreviewInfo(
      user,
      activeNode.id,
      activeNode.space_id,
    );

    expect(result).toEqual({ url: 'https://signed.example/preview' });
    expect(storage.signedViewUrl).toHaveBeenCalledWith(
      'org-1/file-explorer/space-1/node-1/version-1/Fallback.PDF',
    );
  });

  it('throws NotFoundException when previewed node belongs to a different expected space', async () => {
    repo.findFileNode.mockResolvedValue({ ...activeNode, space_id: 'space-2' });

    await expect(
      service.getPreviewInfo(user, activeNode.id, activeNode.space_id),
    ).rejects.toThrow(NotFoundException);

    expect(access.resolveEffectivePermission).not.toHaveBeenCalled();
    expect(repo.resolveVersion).not.toHaveBeenCalled();
    expect(storage.signedViewUrl).not.toHaveBeenCalled();
  });

  it('keeps missing view access hidden as NotFoundException for preview', async () => {
    repo.findFileNode.mockResolvedValue(activeNode);
    access.resolveEffectivePermission.mockResolvedValue({
      canView: false,
      canCreate: true,
      canDelete: true,
    });

    await expect(
      service.getPreviewInfo(user, activeNode.id, activeNode.space_id),
    ).rejects.toThrow(NotFoundException);

    expect(repo.resolveVersion).not.toHaveBeenCalled();
    expect(storage.signedViewUrl).not.toHaveBeenCalled();
  });

  it('returns null preview URL for unsupported MIME types', async () => {
    repo.findFileNode.mockResolvedValue({
      ...activeNode,
      mime_type: 'application/x-msdownload',
    });

    const result = await service.getPreviewInfo(
      user,
      activeNode.id,
      activeNode.space_id,
    );

    expect(result).toEqual({ url: null });
    expect(repo.resolveVersion).not.toHaveBeenCalled();
    expect(storage.signedViewUrl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    ['ppt', 'application/vnd.ms-powerpoint'],
  ])(
    'returns null preview URL for PowerPoint (%s) so the UI shows its download fallback',
    async (_label, mime) => {
      // A browser cannot render a deck inline, so the contract is an explicit
      // { url: null } — NOT an error. The dialog turns that into "no preview
      // available" plus a Download button; a thrown 404 would render a dead end.
      repo.findFileNode.mockResolvedValue({ ...activeNode, mime_type: mime });

      const result = await service.getPreviewInfo(
        user,
        activeNode.id,
        activeNode.space_id,
      );

      expect(result).toEqual({ url: null });
      expect(storage.signedViewUrl).not.toHaveBeenCalled();
    },
  );

  it('soft-deletes an active node and descendants in the expected space', async () => {
    const descendant = childNode();

    repo.findNodeAny.mockResolvedValue(activeNode);
    repo.listDescendants.mockResolvedValue([descendant]);

    await service.softDelete(user, activeNode.id, activeNode.space_id);

    expect(repo.findNodeAny).toHaveBeenCalledWith(activeNode.id);
    expect(access.resolveEffectivePermission).toHaveBeenCalledWith(
      user,
      activeNode,
    );
    expect(from).toHaveBeenCalledWith('fe_nodes');
    const updatePayload = (
      updateChain.update.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;

    expect(updatePayload).toEqual(
      expect.objectContaining({
        is_deleted: true,
        deleted_by: user.userId,
      }),
    );
    expect(typeof updatePayload['delete_op_id']).toBe('string');
    expect(updateChain.in).toHaveBeenCalledWith('id', [
      activeNode.id,
      descendant.id,
    ]);
    expect(updateChain.eq).toHaveBeenCalledWith('is_deleted', false);
    expect(auditLogs.logAction).toHaveBeenCalledWith(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      activeNode.id,
      'delete',
      expect.objectContaining({ subtree_count: 2 }),
    );
  });

  it('throws NotFoundException when the node belongs to a different expected space', async () => {
    repo.findNodeAny.mockResolvedValue({ ...activeNode, space_id: 'space-2' });

    await expect(
      service.softDelete(user, activeNode.id, activeNode.space_id),
    ).rejects.toThrow(NotFoundException);

    expect(access.resolveEffectivePermission).not.toHaveBeenCalled();
    expect(updateChain.update).not.toHaveBeenCalled();
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('treats an already-deleted accessible node as idempotent', async () => {
    repo.findNodeAny.mockResolvedValue({
      ...activeNode,
      is_deleted: true,
      deleted_at: '2026-01-02T00:00:00Z',
      deleted_by: user.userId,
    });

    await service.softDelete(user, activeNode.id, activeNode.space_id);

    expect(access.resolveEffectivePermission).toHaveBeenCalled();
    expect(repo.listDescendants).not.toHaveBeenCalled();
    expect(updateChain.update).not.toHaveBeenCalled();
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('keeps access denial hidden as NotFoundException', async () => {
    repo.findNodeAny.mockResolvedValue(activeNode);
    access.resolveEffectivePermission.mockResolvedValue({
      canView: true,
      canCreate: false,
      canDelete: false,
    });

    await expect(
      service.softDelete(user, activeNode.id, activeNode.space_id),
    ).rejects.toThrow(NotFoundException);

    expect(repo.listDescendants).not.toHaveBeenCalled();
    expect(updateChain.update).not.toHaveBeenCalled();
    expect(auditLogs.logAction).not.toHaveBeenCalled();
  });

  it('renames an active node in the expected space with a trimmed name', async () => {
    const updatedNode = { ...activeNode, name: 'Renamed.pdf' };

    repo.findNode.mockResolvedValue(activeNode);
    repo.updateNode.mockResolvedValue(updatedNode);
    access.resolveEffectivePermission.mockResolvedValue({
      canView: true,
      canCreate: true,
      canDelete: false,
    });

    const result = await service.rename(
      user,
      activeNode.id,
      { name: '  Renamed.pdf  ' },
      activeNode.space_id,
    );

    expect(result).toBe(updatedNode);
    expect(repo.findNode).toHaveBeenCalledWith(activeNode.id);
    expect(access.resolveEffectivePermission).toHaveBeenCalledWith(
      user,
      activeNode,
    );
    expect(repo.updateNode).toHaveBeenCalledWith(activeNode.id, user.userId, {
      name: 'Renamed.pdf',
      description: undefined,
    });
    expect(auditLogs.logAction).toHaveBeenCalledWith(
      user.organizationId,
      user.userId,
      'file_explorer_node',
      activeNode.id,
      'update',
      { action: 'rename', name: 'Renamed.pdf' },
    );
  });

  it('throws NotFoundException when renamed node belongs to a different expected space', async () => {
    repo.findNode.mockResolvedValue({ ...activeNode, space_id: 'space-2' });

    await expect(
      service.rename(
        user,
        activeNode.id,
        { name: 'Renamed.pdf' },
        activeNode.space_id,
      ),
    ).rejects.toThrow(NotFoundException);

    expect(access.resolveEffectivePermission).not.toHaveBeenCalled();
    expect(repo.updateNode).not.toHaveBeenCalled();
  });

  it('keeps missing create access hidden as NotFoundException for rename', async () => {
    repo.findNode.mockResolvedValue(activeNode);
    access.resolveEffectivePermission.mockResolvedValue({
      canView: true,
      canCreate: false,
      canDelete: true,
    });

    await expect(
      service.rename(
        user,
        activeNode.id,
        { name: 'Renamed.pdf' },
        activeNode.space_id,
      ),
    ).rejects.toThrow(NotFoundException);

    expect(repo.updateNode).not.toHaveBeenCalled();
  });

  it('maps duplicate sibling names to ConflictException for rename', async () => {
    repo.findNode.mockResolvedValue(activeNode);
    repo.updateNode.mockRejectedValue({ code: '23505' });
    access.resolveEffectivePermission.mockResolvedValue({
      canView: true,
      canCreate: true,
      canDelete: false,
    });

    await expect(
      service.rename(
        user,
        activeNode.id,
        { name: 'Renamed.pdf' },
        activeNode.space_id,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects whitespace-only rename values before updating the node', async () => {
    repo.findNode.mockResolvedValue(activeNode);
    access.resolveEffectivePermission.mockResolvedValue({
      canView: true,
      canCreate: true,
      canDelete: false,
    });

    await expect(
      service.rename(user, activeNode.id, { name: '   ' }, activeNode.space_id),
    ).rejects.toThrow(BadRequestException);

    expect(repo.updateNode).not.toHaveBeenCalled();
  });
});
