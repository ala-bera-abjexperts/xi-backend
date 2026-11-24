export interface IFeUserStub {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}

export type FeNodeType = 'file' | 'folder';

export interface IFeNode {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  // ancestor_ids added by migration 30260603150000_fe_ancestor_ids.sql
  ancestor_ids: string[];
  node_type: FeNodeType;
  name: string;
  description: string | null;
  mime_type: string | null;
  file_size: number | null;
  current_version_id: string | null;
  // delete_op_id added by migration 30260603160000_fe_upload_status_delete_op.sql
  delete_op_id: string | null;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  current_version?: IFeVersionSlim | null;
  created_by_user?: IFeUserStub | null;
  labels?: IFeLabelSlim[];
  is_starred?: boolean;
  shares_count?: number;
  // Signed thumbnail URL for image files (short TTL, optional)
  thumbnail_url?: string;
}

export interface IFeVersionSlim {
  id: string;
  version_number: number;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_at: string;
  uploaded_by: string | null;
  comment: string | null;
  uploader?: IFeUserStub | null;
}

export interface IFeLabelSlim {
  id: string;
  name: string;
  color: string;
}
