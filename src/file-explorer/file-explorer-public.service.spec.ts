import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { FileExplorerService } from './file-explorer.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';
import type { IFeShare } from './interfaces/fe-share.interface';
import type { IFeVersion } from './interfaces/fe-version.interface';

describe('FileExplorerService public shares', () => {
  const token = 'public-token';
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  } satisfies RequestUser;

  let repo: {
    enrichNodes: jest.Mock;
    findNode: jest.Mock;
    resolveVersion: jest.Mock;
    listActiveDescendantsForPublicFolder: jest.Mock;
    listActiveVersionsByIds: jest.Mock;
  };
  let storage: {
    signedDownloadUrl: jest.Mock;
  };
  let access: {
    resolvePublicShare: jest.Mock;
    resolveEffectivePermission: jest.Mock;
  };
  let from: jest.Mock;
  let service: FileExplorerService;

  function node(overrides: Partial<IFeNode> = {}): IFeNode {
    return {
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
      ...overrides,
    };
  }

  function share(overrides: Partial<IFeShare> = {}): IFeShare {
    return {
      id: 'share-1',
      node_id: 'node-1',
      organization_id: 'org-1',
      share_type: 'link',
      shared_with_id: null,
      can_view: true,
      can_create: false,
      can_delete: false,
      token,
      expires_at: null,
      is_active: true,
      shared_by: 'user-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function version(overrides: Partial<IFeVersion> = {}): IFeVersion {
    return {
      id: 'version-1',
      node_id: 'node-1',
      version_number: 1,
      file_path: 'org-1/file-explorer/space-1/node-1/version-1/Example.pdf',
      file_size: 10,
      mime_type: 'application/pdf',
      upload_status: 'active',
      comment: null,
      uploaded_by: 'user-1',
      uploaded_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function mockVerifyPasswordRow(row: Record<string, unknown> | null) {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
    };

    from.mockReturnValue(chain);

    return chain;
  }

  beforeEach(() => {
    repo = {
      enrichNodes: jest.fn((nodes: IFeNode[]) => nodes),
      findNode: jest.fn(),
      resolveVersion: jest.fn(),
      listActiveDescendantsForPublicFolder: jest.fn(),
      listActiveVersionsByIds: jest.fn(),
    };
    storage = {
      signedDownloadUrl: jest.fn(),
    };
    access = {
      resolvePublicShare: jest.fn(),
      resolveEffectivePermission: jest.fn().mockResolvedValue({
        canView: true,
        canCreate: false,
        canDelete: false,
      }),
    };
    from = jest.fn();

    service = new FileExplorerService(
      { getClient: () => ({ from }) } as never,
      repo as never,
      storage as never,
      { logAction: jest.fn() } as never,
      access as never,
      {
        checkUploadAllowed: jest.fn().mockResolvedValue({ allowed: true }),
      } as never,
    );
  });

  it('keeps file public downloads as signed URL redirects', async () => {
    const fileNode = node();
    const fileVersion = version();

    access.resolvePublicShare.mockResolvedValue({
      share: share(),
      node: fileNode,
    });
    repo.resolveVersion.mockResolvedValue(fileVersion);
    storage.signedDownloadUrl.mockResolvedValue('https://storage.test/signed');

    await expect(service.getPublicDownloadInfo(token)).resolves.toEqual({
      type: 'file',
      signedUrl: 'https://storage.test/signed',
    });
    expect(repo.resolveVersion).toHaveBeenCalledWith(fileNode);
    expect(storage.signedDownloadUrl).toHaveBeenCalledWith(
      fileVersion.file_path,
      fileNode.name,
    );
  });

  it('keeps authenticated file downloads as signed URL redirects', async () => {
    const fileNode = node();
    const fileVersion = version();

    repo.findNode.mockResolvedValue(fileNode);
    repo.resolveVersion.mockResolvedValue(fileVersion);
    storage.signedDownloadUrl.mockResolvedValue('https://storage.test/signed');

    await expect(service.getDownloadInfo(user, fileNode.id)).resolves.toEqual({
      type: 'file',
      signedUrl: 'https://storage.test/signed',
    });
    expect(access.resolveEffectivePermission).toHaveBeenCalledWith(
      user,
      fileNode,
    );
    expect(storage.signedDownloadUrl).toHaveBeenCalledWith(
      fileVersion.file_path,
      fileNode.name,
    );
  });

  it('returns a ZIP manifest for authenticated folder downloads', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      name: 'Client Docs',
      current_version_id: null,
      file_size: null,
    });
    const childFile = node({
      id: 'file-1',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      name: 'Readme.txt',
      mime_type: 'text/plain',
      current_version_id: 'version-1',
    });

    repo.findNode.mockResolvedValue(folder);
    repo.listActiveDescendantsForPublicFolder.mockResolvedValue([childFile]);
    repo.listActiveVersionsByIds.mockResolvedValue(
      new Map([
        [
          'version-1',
          version({
            id: 'version-1',
            file_path: 'files/readme.txt',
            file_size: 12,
          }),
        ],
      ]),
    );

    await expect(service.getDownloadInfo(user, folder.id)).resolves.toEqual({
      type: 'zip',
      fileName: 'Client Docs.zip',
      totalBytes: 12,
      entries: [
        {
          archivePath: 'Readme.txt',
          storagePath: 'files/readme.txt',
          size: 12,
        },
      ],
    });
    expect(access.resolveEffectivePermission).toHaveBeenCalledWith(
      user,
      folder,
    );
  });

  it('returns a ZIP manifest for folder public downloads', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      name: 'Anleitungen',
      current_version_id: null,
      file_size: null,
    });
    const childFolder = node({
      id: 'folder-2',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      node_type: 'folder',
      name: 'Docs',
      current_version_id: null,
      file_size: null,
    });
    const rootFile = node({
      id: 'file-1',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      name: 'Readme.txt',
      mime_type: 'text/plain',
      current_version_id: 'version-1',
    });
    const nestedFile = node({
      id: 'file-2',
      parent_id: childFolder.id,
      ancestor_ids: [folder.id, childFolder.id],
      name: 'Guide.pdf',
      current_version_id: 'version-2',
    });

    access.resolvePublicShare.mockResolvedValue({
      share: share({ node_id: folder.id }),
      node: folder,
    });
    repo.listActiveDescendantsForPublicFolder.mockResolvedValue([
      rootFile,
      childFolder,
      nestedFile,
    ]);
    repo.listActiveVersionsByIds.mockResolvedValue(
      new Map([
        [
          'version-1',
          version({
            id: 'version-1',
            file_path: 'files/readme.txt',
            file_size: 12,
          }),
        ],
        [
          'version-2',
          version({
            id: 'version-2',
            file_path: 'files/guide.pdf',
            file_size: 34,
          }),
        ],
      ]),
    );

    await expect(service.getPublicDownloadInfo(token)).resolves.toEqual({
      type: 'zip',
      fileName: 'Anleitungen.zip',
      totalBytes: 46,
      entries: [
        {
          archivePath: 'Docs/Guide.pdf',
          storagePath: 'files/guide.pdf',
          size: 34,
        },
        {
          archivePath: 'Readme.txt',
          storagePath: 'files/readme.txt',
          size: 12,
        },
      ],
    });
  });

  it('returns recursive public folder contents for folder shares', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      name: 'Parent Folder',
      mime_type: null,
      current_version_id: null,
      file_size: null,
    });
    const childFolder = node({
      id: 'folder-2',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      node_type: 'folder',
      name: 'Docs',
      mime_type: null,
      current_version_id: null,
      file_size: null,
      updated_at: '2026-01-02T00:00:00Z',
    });
    const rootFile = node({
      id: 'file-1',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      name: 'Readme.txt',
      mime_type: 'text/plain',
      file_size: 12,
      current_version_id: 'version-1',
      updated_at: '2026-01-03T00:00:00Z',
    });
    const nestedFile = node({
      id: 'file-2',
      parent_id: childFolder.id,
      ancestor_ids: [folder.id, childFolder.id],
      name: 'Guide.pdf',
      file_size: 34,
      current_version_id: 'version-2',
      updated_at: '2026-01-04T00:00:00Z',
    });

    access.resolvePublicShare.mockResolvedValue({
      share: share({ node_id: folder.id }),
      node: folder,
    });
    repo.listActiveDescendantsForPublicFolder.mockResolvedValue([
      rootFile,
      childFolder,
      nestedFile,
    ]);

    await expect(service.getPublicFolderContents(token)).resolves.toEqual({
      root: {
        id: folder.id,
        name: 'Parent Folder',
        nodeType: 'folder',
        mimeType: null,
        fileSize: null,
        updatedAt: '2026-01-01T00:00:00Z',
      },
      items: [
        {
          id: childFolder.id,
          name: 'Docs',
          nodeType: 'folder',
          mimeType: null,
          fileSize: null,
          updatedAt: '2026-01-02T00:00:00Z',
          parentId: folder.id,
          depth: 0,
          relativePath: 'Docs',
        },
        {
          id: nestedFile.id,
          name: 'Guide.pdf',
          nodeType: 'file',
          mimeType: 'application/pdf',
          fileSize: 34,
          updatedAt: '2026-01-04T00:00:00Z',
          parentId: childFolder.id,
          depth: 1,
          relativePath: 'Docs/Guide.pdf',
        },
        {
          id: rootFile.id,
          name: 'Readme.txt',
          nodeType: 'file',
          mimeType: 'text/plain',
          fileSize: 12,
          updatedAt: '2026-01-03T00:00:00Z',
          parentId: folder.id,
          depth: 0,
          relativePath: 'Readme.txt',
        },
      ],
      totalItems: 3,
      totalFiles: 2,
      totalFolders: 1,
      totalBytes: 46,
    });
  });

  it('allows a descendant file download from a folder share via nodeId', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      current_version_id: null,
    });
    const child = node({
      id: 'file-1',
      parent_id: folder.id,
      ancestor_ids: [folder.id],
      name: 'Child.pdf',
    });
    const childVersion = version({ file_path: 'files/child.pdf' });

    access.resolvePublicShare.mockResolvedValue({
      share: share({ node_id: folder.id }),
      node: folder,
    });
    repo.findNode.mockResolvedValue(child);
    repo.resolveVersion.mockResolvedValue(childVersion);
    storage.signedDownloadUrl.mockResolvedValue('https://storage.test/child');

    await expect(
      service.getPublicDownloadInfo(token, child.id),
    ).resolves.toEqual({
      type: 'file',
      signedUrl: 'https://storage.test/child',
    });
    expect(repo.findNode).toHaveBeenCalledWith(child.id);
    expect(repo.listActiveDescendantsForPublicFolder).not.toHaveBeenCalled();
  });

  it('rejects nodeId values outside the shared folder subtree', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      current_version_id: null,
    });
    const sibling = node({
      id: 'file-1',
      ancestor_ids: ['other-folder'],
    });

    access.resolvePublicShare.mockResolvedValue({
      share: share({ node_id: folder.id }),
      node: folder,
    });
    repo.findNode.mockResolvedValue(sibling);

    await expect(
      service.getPublicDownloadInfo(token, sibling.id),
    ).rejects.toThrow(NotFoundException);
    expect(storage.signedDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects empty public folder downloads with a clear message', async () => {
    const folder = node({
      id: 'folder-1',
      node_type: 'folder',
      current_version_id: null,
    });

    access.resolvePublicShare.mockResolvedValue({
      share: share({ node_id: folder.id }),
      node: folder,
    });
    repo.listActiveDescendantsForPublicFolder.mockResolvedValue([]);

    await expect(service.getPublicDownloadInfo(token)).rejects.toThrow(
      new BadRequestException('Folder has no downloadable files'),
    );
  });

  it('requires a verified cookie for password-protected public downloads', async () => {
    const passwordHash = await bcrypt.hash('secret', 10);
    const fileNode = node();
    const protectedShare = share() as IFeShare & { password_hash: string };

    protectedShare.password_hash = passwordHash;
    access.resolvePublicShare.mockResolvedValue({
      share: protectedShare,
      node: fileNode,
    });

    await expect(service.getPublicDownloadInfo(token)).rejects.toThrow(
      UnauthorizedException,
    );

    mockVerifyPasswordRow({
      id: protectedShare.id,
      password_hash: passwordHash,
      is_active: true,
      expires_at: null,
    });

    const verifyResult = await service.verifyPublicPassword(token, 'secret');

    repo.resolveVersion.mockResolvedValue(version());
    storage.signedDownloadUrl.mockResolvedValue('https://storage.test/signed');

    await expect(
      service.getPublicDownloadInfo(
        token,
        undefined,
        verifyResult.accessCookie?.value,
      ),
    ).resolves.toEqual({
      type: 'file',
      signedUrl: 'https://storage.test/signed',
    });
  });
});
