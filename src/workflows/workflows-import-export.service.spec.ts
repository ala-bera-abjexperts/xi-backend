/**
 * @fileoverview Tests for workflow export — id-free doc, key/name de-id-ing,
 * and volatile (user/group/role) rule-param stripping.
 * @module src/workflows/workflows-import-export.service.spec
 * @author Rajbha Manek
 */
import { WorkflowsImportExportService } from './workflows-import-export.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import type { WorkflowsService } from './workflows.service';

const ORG = 'org-1';

// Minimal thenable chain whose terminal resolves to `data` regardless of the
// builder methods called (select/eq/in/...).
function chain(data: unknown) {
  const c: Record<string, unknown> = {};
  const self = () => c;

  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) {
    c[m] = jest.fn().mockImplementation(self);
  }
  c.then = (cb: (v: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(cb);

  return c;
}

describe('WorkflowsImportExportService.exportWorkflow', () => {
  function build(detail: Record<string, unknown>) {
    const from = jest.fn((table: string) => {
      if (table === 'task_statuses') {
        return chain([
          { id: 'st-open', key: 'open' },
          { id: 'st-done', key: 'done' },
        ]);
      }
      if (table === 'field_groups') {
        return chain([{ id: 'fg-1', name: 'Resolve Screen' }]);
      }

      return chain([]);
    });
    const supa = {
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService;

    // Registry: the assign-to post-function references a user id.
    const registry = {
      get: jest.fn((_phase: string, type: string) =>
        type === 'assign_to'
          ? {
              findReferences: () => [{ kind: 'user', id: 'user-xyz' }],
            }
          : undefined,
      ),
    } as unknown as HandlerRegistryService;

    const workflows = {
      getDetail: jest.fn().mockResolvedValue(detail),
    } as unknown as WorkflowsService;

    return new WorkflowsImportExportService(supa, registry, workflows);
  }

  it('produces an id-free doc keyed by status key + field-group name, with volatile params stripped', async () => {
    const detail = {
      name: 'Bug Flow',
      description: 'desc',
      initial_status_id: 'st-open',
      layout: { viewport: { x: 0, y: 0, zoom: 1 } },
      nodes: [
        {
          id: 'n-start',
          kind: 'start',
          status_id: null,
          label: null,
          position_x: 0,
          position_y: 0,
          properties: {},
        },
        {
          id: 'n-open',
          kind: 'status',
          status_id: 'st-open',
          label: null,
          position_x: 10,
          position_y: 20,
          properties: {},
        },
        {
          id: 'n-done',
          kind: 'status',
          status_id: 'st-done',
          label: null,
          position_x: 30,
          position_y: 40,
          properties: {},
        },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Resolve',
          kind: 'regular',
          to_node_id: 'n-done',
          screen_field_group_id: 'fg-1',
          conditions: [],
          validators: [],
          post_functions: [{ type: 'assign_to', user_id: 'user-xyz' }],
          triggers: [],
          properties: {},
          sort_order: 1,
        },
      ],
      sources: [{ transition_id: 't1', from_node_id: 'n-open' }],
      branches: [],
    };

    const svc = build(detail);
    const doc = await svc.exportWorkflow('wf-1', ORG);

    expect(doc.export_version).toBe(1);
    expect(doc.initial_status_key).toBe('open');

    const statusNode = doc.nodes.find((n) => n.local_id === 'n-done');

    expect(statusNode?.status_key).toBe('done');

    const tx = doc.transitions[0];

    expect(tx.name).toBe('Resolve');
    expect(tx.to_node_local_id).toBe('n-done');
    expect(tx.from_node_local_ids).toEqual(['n-open']);
    expect(tx.screen_field_group_name).toBe('Resolve Screen');
    // Volatile user id nulled + recorded in _unresolved.
    expect((tx.post_functions[0] as { user_id: unknown }).user_id).toBeNull();
    expect(tx._unresolved).toEqual([
      { phase: 'post_function', type: 'assign_to', kinds: ['user'] },
    ]);

    // No raw DB UUIDs leak into the doc as references.
    expect(JSON.stringify(doc)).not.toContain('user-xyz');
  });

  it('handles an empty workflow (no nodes/transitions) without throwing', async () => {
    const svc = build({
      name: 'Empty',
      description: null,
      initial_status_id: null,
      layout: {},
      nodes: [],
      transitions: [],
      sources: [],
      branches: [],
    });
    const doc = await svc.exportWorkflow('wf-2', ORG);

    expect(doc.nodes).toEqual([]);
    expect(doc.transitions).toEqual([]);
    expect(doc.initial_status_key).toBeNull();
  });
});
