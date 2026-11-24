/**
 * @fileoverview Guards the wiki audit trail against the fire-and-forget bug: a
 * PostgREST builder only issues its request from `then()`, so `void builder`
 * silently sends nothing. These tests assert the insert is actually AWAITED,
 * not merely constructed — a spy on `.insert()` alone passes either way.
 * @module src/wiki/wiki-audit-log.spec
 * @author Prince Jadiya
 */
import { WikiWorkflowService } from './wiki-workflow.service';
import { WikiService } from './wiki.service';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { WikiPermissionsService } from './wiki-permissions.service';

interface AuditChain extends Record<string, unknown> {
  awaited: boolean;
  payload: Record<string, unknown> | null;
}

/**
 * Mock `audit_logs` builder that is a thenable, like the real client: the
 * `awaited` flag only flips when something actually calls `then()`.
 */
function auditChain(): AuditChain {
  const chain = { awaited: false, payload: null } as AuditChain;

  chain.insert = jest.fn((payload: Record<string, unknown>) => {
    chain.payload = payload;

    return chain;
  });
  chain.then = (resolve: (v: unknown) => unknown) => {
    chain.awaited = true;

    return Promise.resolve({ data: null, error: null }).then(resolve);
  };

  return chain;
}

/** Generic chain whose terminal reads resolve to `result`. */
function dataChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  for (const m of [
    'select',
    'update',
    'insert',
    'eq',
    'in',
    'order',
    'limit',
  ]) {
    chain[m] = jest.fn(self);
  }
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.single = jest.fn(() => Promise.resolve(result));
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);

  return chain;
}

describe('wiki audit trail is actually written', () => {
  let audit: AuditChain;
  let from: jest.Mock;

  const PAGE_ID = 'page-1';
  const SPACE_ID = 'space-1';
  const ORG_ID = 'org-1';
  const USER_ID = 'user-1';

  beforeEach(() => {
    audit = auditChain();
  });

  describe('WikiWorkflowService.transition', () => {
    it('awaits the audit_logs insert for a workflow transition', async () => {
      const page = {
        id: PAGE_ID,
        organization_id: ORG_ID,
        space_id: SPACE_ID,
        title: 'A page',
        created_by: USER_ID,
        is_archived: false,
        is_published: true,
        workflow_status: 'published',
        workflow_metadata: {},
        metadata: {},
      };

      from = jest.fn((table: string) => {
        if (table === 'audit_logs') return audit;
        if (table === 'wiki_space_settings') {
          return dataChain({ data: null, error: null });
        }

        // wiki_pages: loadPage, the update, and reloadPage all resolve here.
        return dataChain({ data: page, error: null });
      });

      const service = new WikiWorkflowService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        {
          resolveWithTrace: jest.fn().mockResolvedValue({
            source: 'admin',
            decision: { can_edit: true },
          }),
        } as unknown as WikiPermissionsService,
      );

      await service.transition(
        PAGE_ID,
        SPACE_ID,
        { userId: USER_ID, organizationId: ORG_ID } as never,
        { action: 'unpublish' } as never,
      );

      // The assertion that matters: constructed AND sent.
      expect(audit.insert).toHaveBeenCalled();
      expect(audit.awaited).toBe(true);
      expect(audit.payload).toMatchObject({
        organization_id: ORG_ID,
        user_id: USER_ID,
        entity_type: 'wiki_page',
        entity_id: PAGE_ID,
        action: 'workflow_transition',
      });
    });
  });

  describe('WikiService.logAudit', () => {
    it('awaits the audit_logs insert', async () => {
      from = jest.fn(() => audit);

      const service = Object.create(WikiService.prototype) as WikiService;

      Object.defineProperty(service, 'client', {
        get: () => ({ from }),
      });

      await (
        service as unknown as {
          logAudit: (
            orgId: unknown,
            userId: string,
            entityId: string,
            action: string,
            changes?: Record<string, unknown>,
          ) => Promise<void>;
        }
      ).logAudit(ORG_ID, USER_ID, PAGE_ID, 'create', { title: 'A page' });

      expect(audit.insert).toHaveBeenCalled();
      expect(audit.awaited).toBe(true);
      expect(audit.payload).toMatchObject({
        organization_id: ORG_ID,
        entity_type: 'wiki_page',
        action: 'create',
      });
    });

    it('skips the write entirely when the organization id is not a string', async () => {
      from = jest.fn(() => audit);

      const service = Object.create(WikiService.prototype) as WikiService;

      Object.defineProperty(service, 'client', {
        get: () => ({ from }),
      });

      await (
        service as unknown as {
          logAudit: (
            orgId: unknown,
            u: string,
            e: string,
            a: string,
          ) => Promise<void>;
        }
      ).logAudit(null, USER_ID, PAGE_ID, 'create');

      expect(audit.insert).not.toHaveBeenCalled();
      expect(audit.awaited).toBe(false);
    });
  });
});
