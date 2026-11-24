/**
 * @fileoverview Smoke + branch tests for the public inbound webhook endpoint.
 * Exercises the controller and service together since the controller is a
 * thin pass-through — branch coverage lives in the service, but driving it
 * through the controller proves the wiring (signature header, secret param,
 * body forwarding) is correct end-to-end.
 *
 * Covers:
 *   1. Happy path → 202 + execution_id, engine.executeTransition called.
 *   2. Bad HMAC → 401.
 *   3. No trigger matches the secret → 404.
 *   4. Workflow archived → 410.
 *   5. Engine runtime absent (P6 not yet wired) → 503.
 *
 * @module src/workflow-triggers/workflow-triggers.controller.spec
 * @author Prince Jadiya
 */

/* eslint-disable @typescript-eslint/unbound-method */

import { createHmac } from 'crypto';
import {
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IWorkflowEngineRuntime } from './workflow-engine.contract';
import { WorkflowTriggersController } from './workflow-triggers.controller';
import { WorkflowTriggersService } from './workflow-triggers.service';

describe('WorkflowTriggersController', () => {
  let mockFrom: jest.Mock;

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.filter = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  function makeFromImpl(
    map: Record<
      string,
      ReturnType<typeof buildChain> | ReturnType<typeof buildChain>[]
    >,
  ) {
    const queues: Record<string, ReturnType<typeof buildChain>[]> = {};

    for (const [table, value] of Object.entries(map)) {
      queues[table] = Array.isArray(value) ? [...value] : [value];
    }

    return (table: string) => {
      const queue = queues[table];

      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected from(${table}) call in test`);
      }

      return queue.length > 1 ? queue.shift()! : queue[0];
    };
  }

  function buildSupa(): SupabaseAdminService {
    mockFrom = jest.fn();

    return {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
  }

  function buildEngine(): jest.Mocked<IWorkflowEngineRuntime> {
    return {
      executeTransition: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IWorkflowEngineRuntime>;
  }

  function buildController(opts: {
    supa: SupabaseAdminService;
    engine?: IWorkflowEngineRuntime;
  }) {
    const service = new WorkflowTriggersService(opts.supa, opts.engine);

    return {
      controller: new WorkflowTriggersController(service),
      service,
    };
  }

  const SECRET = 'inbound-secret-1';
  const TX_ID = 'tx-1';
  const WF_ID = 'wf-1';
  const ORG = 'org-1';
  const CREATOR = 'user-creator';
  const TASK_ID = 'task-1';

  function transitionRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: TX_ID,
      workflow_id: WF_ID,
      triggers: [
        {
          type: 'inbound_webhook',
          secret: SECRET,
          ...((overrides.triggerCfg as Record<string, unknown>) ?? {}),
        },
      ],
      workflows: {
        id: WF_ID,
        organization_id: ORG,
        is_archived: false,
        is_active: true,
        created_by: CREATOR,
        ...((overrides.workflows as Record<string, unknown>) ?? {}),
      },
    };
  }

  it('returns 202 + execution_id on the happy path', async () => {
    const supa = buildSupa();
    const engine = buildEngine();

    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [transitionRow()],
          error: null,
        }),
        users: buildChain({
          data: {
            id: CREATOR,
            email: 'creator@example.com',
            organization_id: ORG,
            role: 'admin',
            is_active: true,
          },
          error: null,
        }),
      }),
    );

    const { controller } = buildController({ supa, engine });
    const result = (await controller.inbound(
      SECRET,
      { task_id: TASK_ID, foo: 'bar' },
      undefined,
    )) as { accepted: boolean; execution_id: string };

    // The endpoint is decorated with @HttpCode(HttpStatus.ACCEPTED) so the
    // wire status is 202. Reflect-metadata is the only way to verify this
    // from a unit-style test (no supertest harness here).
    const httpCode = Reflect.getMetadata('__httpCode__', controller.inbound) as
      | number
      | undefined;

    expect(httpCode).toBe(202);
    expect(result).toEqual({
      accepted: true,
      execution_id: expect.any(String) as string,
    });
    expect(engine.executeTransition).toHaveBeenCalledTimes(1);
    const call = (
      engine.executeTransition.mock.calls as [
        {
          taskId: string;
          transitionId: string;
          screenInput: Record<string, unknown>;
          executionId: string;
          user: { userId: string; organizationId: string };
        },
      ][]
    )[0][0];

    expect(call.taskId).toBe(TASK_ID);
    expect(call.transitionId).toBe(TX_ID);
    expect(call.screenInput).toEqual({ task_id: TASK_ID, foo: 'bar' });
    expect(call.executionId).toBe(result.execution_id);
    expect(call.user.userId).toBe(CREATOR);
    expect(call.user.organizationId).toBe(ORG);
  });

  it('throws UnauthorizedException (401) when HMAC signature is bad', async () => {
    const supa = buildSupa();
    const engine = buildEngine();

    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [
            transitionRow({
              triggerCfg: { require_signature: true },
            }),
          ],
          error: null,
        }),
      }),
    );

    const { controller } = buildController({ supa, engine });

    await expect(
      controller.inbound(SECRET, { task_id: TASK_ID }, 'sha256=deadbeef'),
    ).rejects.toThrow(UnauthorizedException);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('throws NotFoundException (404) when no trigger matches the secret', async () => {
    const supa = buildSupa();
    const engine = buildEngine();

    // JSONB containment hit returns rows whose secret does NOT match.
    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [
            transitionRow({
              triggerCfg: { secret: 'a-different-secret' },
            }),
          ],
          error: null,
        }),
      }),
    );

    const { controller } = buildController({ supa, engine });

    await expect(
      controller.inbound(SECRET, { task_id: TASK_ID }, undefined),
    ).rejects.toThrow(NotFoundException);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('throws GoneException (410) when the parent workflow is archived', async () => {
    const supa = buildSupa();
    const engine = buildEngine();

    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [
            transitionRow({
              workflows: {
                id: WF_ID,
                organization_id: ORG,
                is_archived: true,
                is_active: false,
                created_by: CREATOR,
              },
            }),
          ],
          error: null,
        }),
      }),
    );

    const { controller } = buildController({ supa, engine });

    await expect(
      controller.inbound(SECRET, { task_id: TASK_ID }, undefined),
    ).rejects.toThrow(GoneException);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableException (503) when engine runtime is absent', async () => {
    const supa = buildSupa();

    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [transitionRow()],
          error: null,
        }),
      }),
    );

    // No engine passed → @Optional() injection resolves to undefined.
    const { controller } = buildController({ supa, engine: undefined });

    await expect(
      controller.inbound(SECRET, { task_id: TASK_ID }, undefined),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // -------------------------------------------------------------------------
  // Bonus sanity: prove the HMAC happy path passes when the signature is
  // correctly computed. Not one of the 5 mandated tests but cheap and
  // catches regressions in the verifySignature path on the happy-side.
  // -------------------------------------------------------------------------
  it('accepts a correctly signed request when require_signature=true', async () => {
    const supa = buildSupa();
    const engine = buildEngine();
    const payload = { task_id: TASK_ID, foo: 'bar' };
    const expected = createHmac('sha256', SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');

    mockFrom.mockImplementation(
      makeFromImpl({
        workflow_transitions: buildChain({
          data: [
            transitionRow({
              triggerCfg: { require_signature: true },
            }),
          ],
          error: null,
        }),
        users: buildChain({
          data: {
            id: CREATOR,
            email: 'creator@example.com',
            organization_id: ORG,
            role: 'admin',
            is_active: true,
          },
          error: null,
        }),
      }),
    );

    const { controller } = buildController({ supa, engine });
    const result = await controller.inbound(
      SECRET,
      payload,
      `sha256=${expected}`,
    );

    expect(result.accepted).toBe(true);
    expect(engine.executeTransition).toHaveBeenCalledTimes(1);
  });
});
