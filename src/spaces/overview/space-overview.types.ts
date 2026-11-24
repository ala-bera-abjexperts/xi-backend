/**
 * @fileoverview Response shapes for `GET /spaces/:id/overview`.
 * @module src/spaces/overview/space-overview.types
 */

export type OverviewUpdateType =
  | 'task'
  | 'wiki'
  | 'asset'
  | 'list_item'
  | 'automation'
  | 'process'
  | 'plan'
  | 'board'
  | 'form'
  | 'dashboard'
  | 'file';

export interface OverviewModule {
  module_type: string;
  sort_order: number;

  // Newest change the caller may see in this module; null when it has none or no record type.
  last_updated_at?: string | null;

  // Record count, only for modules without per-record restrictions; null otherwise.
  record_count?: number | null;

  // Records nested under another record (subtasks, sub-processes, sub-pages); same gates as record_count.
  sub_record_count?: number | null;
}

export interface OverviewUpdate {
  id: string;
  type: OverviewUpdateType;
  module_type: string;
  title: string | null;
  key: string | null;
  status: { label: string; color: string | null } | null;
  context: string | null;
  created_at: string | null;
  updated_at: string;
  is_new: boolean;
  updated_by: {
    id: string;
    name: string | null;
    avatar_url: string | null;
  } | null;
  ref: {
    id: string;
    key?: string | null;
    schema_key?: string | null;
    parent_id?: string | null;
    node_type?: string | null;
  };
}

export interface OverviewUser {
  id: string;
  name: string | null;
  avatar_url: string | null;
}

export interface OverviewStorageModule {
  module_type: string;

  // Attachment files: every stored version
  bytes: number;
  files: number;

  // The records themselves (database rows); null when not measurable for the caller
  record_bytes: number | null;
  records: number | null;
}

// Storage held by this space, only for modules the caller can see.
export interface OverviewStorage {
  total_bytes: number;
  file_count: number;
  attachments_bytes: number;
  records_bytes: number | null;
  modules: OverviewStorageModule[];
  file_explorer_quota_bytes: number | null;
}

// Facts about the space itself; counts are null when the caller may not see that data.
export interface OverviewSpaceInfo {
  key: string;
  is_archived: boolean;
  category: string | null;
  space_type_name: string | null;
  created_at: string | null;
  created_by: OverviewUser | null;
  lead: OverviewUser | null;
  member_count: number;
  members_preview: OverviewUser[];
  open_tasks: number | null;
  overdue_tasks: number | null;
  storage?: OverviewStorage | null;
}

export interface SpaceOverview {
  space_id: string;
  modules: OverviewModule[];
  latest_updates: OverviewUpdate[];
  space_info?: OverviewSpaceInfo | null;
}

// One record holding attachments, for the storage breakdown of a module.
export interface OverviewStorageRecord {
  id: string;
  type: OverviewUpdateType;
  module_type: string;
  title: string | null;
  key: string | null;
  files: number;
  bytes: number;
  ref: OverviewUpdate['ref'];

  // Ancestors from the top down, excluding the record; label is null when the caller may not see it.
  path: OverviewStoragePathItem[];
}

export interface OverviewStoragePathItem {
  id: string;
  label: string | null;
  restricted: boolean;
}
