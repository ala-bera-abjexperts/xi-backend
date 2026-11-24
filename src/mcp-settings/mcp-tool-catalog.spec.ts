import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_NAMES,
  isKnownMcpTool,
} from './mcp-tool-catalog';

describe('MCP_TOOL_CATALOG (sync invariant with xisuite-mcp registry)', () => {
  it('pins exactly the 33 known tool names', () => {
    expect(MCP_TOOL_CATALOG.map((t) => t.name).sort()).toEqual(
      [
        'org.current',
        'org.list',
        'permission.explain',
        'space.list',
        'space.get',
        'task.search',
        'task.get',
        'task.statuses.list',
        'task.types.list',
        'task.transitions.list',
        'task.attachments.list',
        'task.subtasks.list',
        'task.history.list',
        'task.relationships.list',
        'task.relation-types.list',
        'task.custom-fields.list',
        'task.attachment.url',
        'task.time-entries.list',
        'task.reminders.list',
        'wiki.search',
        'wiki.get',
        'plan.search',
        'plan.get',
        'task.create',
        'task.update',
        'task.transition.apply',
        'task.comment.edit',
        'task.comment.delete',
        'task.relationships.add',
        'task.relationships.remove',
        'task.comment.add',
        'wiki.create',
        'wiki.update',
      ].sort(),
    );
  });

  it('marks exactly the ten write tools, and isWrite matches the write: scope', () => {
    const writes = MCP_TOOL_CATALOG.filter((t) => t.isWrite).map((t) => t.name);
    expect(writes.sort()).toEqual(
      [
        'task.create',
        'task.update',
        'task.transition.apply',
        'task.comment.edit',
        'task.comment.delete',
        'task.relationships.add',
        'task.relationships.remove',
        'task.comment.add',
        'wiki.create',
        'wiki.update',
      ].sort(),
    );
    for (const t of MCP_TOOL_CATALOG) {
      expect(t.isWrite).toBe(t.requiredScope.startsWith('write:'));
    }
  });

  it('has a category for every entry and a matching name set', () => {
    for (const t of MCP_TOOL_CATALOG) {
      expect(typeof t.category).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
    }
    expect(MCP_TOOL_NAMES.size).toBe(MCP_TOOL_CATALOG.length);
    expect(isKnownMcpTool('task.search')).toBe(true);
    expect(isKnownMcpTool('task.destroy')).toBe(false);
  });
});
