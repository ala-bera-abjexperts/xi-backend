export interface IFeZipEntry {
  archivePath: string;
  storagePath: string;
  size: number;
}

export interface IPublicShareAccessCookie {
  name: string;
  value: string;
  maxAgeSeconds: number;
}

export interface IPublicFolderNodeSummary {
  id: string;
  name: string;
  nodeType: 'file' | 'folder';
  mimeType: string | null;
  fileSize: number | null;
  updatedAt: string;
}

export interface IPublicFolderEntry extends IPublicFolderNodeSummary {
  parentId: string | null;
  depth: number;
  relativePath: string;
}

export interface IPublicFolderContents {
  root: IPublicFolderNodeSummary;
  items: IPublicFolderEntry[];
  totalItems: number;
  totalFiles: number;
  totalFolders: number;
  totalBytes: number;
}

export type PublicDownloadInfo =
  | {
      type: 'file';
      signedUrl: string;
    }
  | {
      type: 'zip';
      fileName: string;
      entries: IFeZipEntry[];
      totalBytes: number;
    };
