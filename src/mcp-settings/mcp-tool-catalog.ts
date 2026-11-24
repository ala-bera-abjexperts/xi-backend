/**
 * @fileoverview Canonical catalog of MCP tools an org can allow/deny.
 *
 * SYNC INVARIANT: this list mirrors `MCP_TOOLS` in the xisuite-mcp repo
 * (src/mcp/tools/registry.ts). The MCP server is authoritative for enforcement;
 * this catalog is what the backend validates tool names against and returns to
 * the tenant-config UI so it can render one toggle per tool. When a tool is
 * added/removed/renamed in xisuite-mcp, update this list (and the frontend i18n
 * labels). A unit test pins the expected 33 names so drift fails loudly.
 * @module src/mcp-settings/mcp-tool-catalog
 */

export type McpToolCategory =
  | 'organization'
  | 'spaces'
  | 'tasks'
  | 'wiki'
  | 'plans';

export interface McpToolCatalogEntry {
  /** Public tool name (matches xisuite-mcp registration + allowed_tools entries). */
  name: string;
  /** UI grouping. */
  category: McpToolCategory;
  /** OAuth scope the connection must hold for this tool. */
  requiredScope: string;
  /** Write tools additionally require the org `allow_write_tools` master toggle. */
  isWrite: boolean;
}

export const MCP_TOOL_CATALOG: readonly McpToolCatalogEntry[] = [
  // profile / introspection
  {
    name: 'org.current',
    category: 'organization',
    requiredScope: 'profile',
    isWrite: false,
  },
  {
    name: 'org.list',
    category: 'organization',
    requiredScope: 'profile',
    isWrite: false,
  },
  {
    name: 'permission.explain',
    category: 'organization',
    requiredScope: 'profile',
    isWrite: false,
  },
  // read:spaces
  {
    name: 'space.list',
    category: 'spaces',
    requiredScope: 'read:spaces',
    isWrite: false,
  },
  {
    name: 'space.get',
    category: 'spaces',
    requiredScope: 'read:spaces',
    isWrite: false,
  },
  // read:tasks
  {
    name: 'task.search',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.get',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.statuses.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.types.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.transitions.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.attachments.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.subtasks.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.history.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.relationships.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.relation-types.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.custom-fields.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.attachment.url',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.time-entries.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  {
    name: 'task.reminders.list',
    category: 'tasks',
    requiredScope: 'read:tasks',
    isWrite: false,
  },
  // read:wiki
  {
    name: 'wiki.search',
    category: 'wiki',
    requiredScope: 'read:wiki',
    isWrite: false,
  },
  {
    name: 'wiki.get',
    category: 'wiki',
    requiredScope: 'read:wiki',
    isWrite: false,
  },
  // read:plans
  {
    name: 'plan.search',
    category: 'plans',
    requiredScope: 'read:plans',
    isWrite: false,
  },
  {
    name: 'plan.get',
    category: 'plans',
    requiredScope: 'read:plans',
    isWrite: false,
  },
  // write:tasks (also gated by allow_write_tools)
  {
    name: 'task.create',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.update',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.transition.apply',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.comment.edit',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.comment.delete',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.relationships.add',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.relationships.remove',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  {
    name: 'task.comment.add',
    category: 'tasks',
    requiredScope: 'write:tasks',
    isWrite: true,
  },
  // write:wiki (also gated by allow_write_tools)
  {
    name: 'wiki.create',
    category: 'wiki',
    requiredScope: 'write:wiki',
    isWrite: true,
  },
  {
    name: 'wiki.update',
    category: 'wiki',
    requiredScope: 'write:wiki',
    isWrite: true,
  },
];

/** Fast membership check for validating an incoming tool name. */
export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  MCP_TOOL_CATALOG.map((t) => t.name),
);

/** True iff `name` is a known MCP tool. */
export function isKnownMcpTool(name: string): boolean {
  return MCP_TOOL_NAMES.has(name);
}
