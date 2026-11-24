import type { IFeUserStub } from './fe-node.interface';

export interface IFeVersion {
  id: string;
  node_id: string;
  version_number: number;
  file_path: string;
  file_size: number;
  mime_type: string;
  // upload_status added by migration 30260603160000_fe_upload_status_delete_op.sql
  upload_status: 'pending' | 'active';
  comment: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  uploader?: IFeUserStub | null;
}
