export type FeShareType = 'link' | 'user';

export interface IFeShare {
  id: string;
  node_id: string;
  organization_id: string;
  share_type: FeShareType;
  shared_with_id: string | null;
  can_view: boolean;
  can_create: boolean;
  can_delete: boolean;
  token: string | null;
  // password_hash is NEVER returned in responses
  expires_at: string | null;
  is_active: boolean;
  shared_by: string | null;
  created_at: string;
  updated_at: string;
  shared_with_user?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    avatar_url: string | null;
  } | null;
}
