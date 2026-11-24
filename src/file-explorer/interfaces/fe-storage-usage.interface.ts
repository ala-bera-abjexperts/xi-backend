export interface IFeStorageUserUsage {
  user_id: string | null;
  name: string;
  email: string | null;
  avatar_url: string | null;
  used_bytes: number;
  file_count: number;
  version_count: number;
  last_uploaded_at: string | null;
}

export interface IFeStorageSpaceUsage {
  space_id: string;
  space_key: string;
  space_name: string;
  is_archived: boolean;
  used_bytes: number;
  quota_bytes: number;
  file_count: number;
  version_count: number;
  trash_bytes: number;
}

export interface IFeStorageLargestFile {
  node_id: string;
  name: string;
  mime_type: string | null;
  space_id: string;
  space_key: string;
  space_name: string;
  created_by: string | null;
  created_by_name: string;
  used_bytes: number;
  current_size_bytes: number;
  version_count: number;
  is_deleted: boolean;
  updated_at: string;
}

export interface IFeOrganizationStorageUsage {
  organization_id: string;
  bucket: 'file-explorer';
  used_bytes: number;
  storage_limit_bytes: number | null;
  file_count: number;
  folder_count: number;
  version_count: number;
  trash_bytes: number;
  today_upload_count: number;
  generated_at: string;
  spaces: IFeStorageSpaceUsage[];
  users: IFeStorageUserUsage[];
  largest_files: IFeStorageLargestFile[];
}
