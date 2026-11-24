import { PlansAiService } from './plans-ai.service';

describe('PlansAiService execution cleanup', () => {
  it('tracks generated risk ids so failed executions clean up created risks', async () => {
    const planRiskDeleteIn = jest.fn().mockResolvedValue({ error: null });

    const makePlanAiGenerationsTable = () => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: {
            id: 'generation-1',
            status: 'completed',
            provider_name: 'test-provider',
            generated_plan: {
              plan_name: 'Generated plan',
              plan_description: 'Generated plan description',
              plan_type: 'waterfall',
              start_date: '2026-06-01',
              end_date: '2026-06-30',
              phases: [
                {
                  name: 'Phase 1',
                  children: [
                    {
                      name: 'Work package 1',
                      children: [{ name: 'Task 1' }],
                    },
                  ],
                },
              ],
              stakeholders: [],
              risks: [
                {
                  name: 'Delivery risk',
                  probability: 3,
                  impact: 4,
                },
              ],
              people: [],
              dependencies: [],
            },
          },
          error: null,
        }),
      }),
      update: jest.fn((patch: Record<string, unknown>) => {
        if (patch['execution_status'] === 'executing') {
          return {
            eq: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            maybeSingle: jest
              .fn()
              .mockResolvedValue({ data: { id: 'generation-1' }, error: null }),
          };
        }

        if (patch['execution_status'] === 'completed') {
          return {
            eq: jest.fn().mockRejectedValue(new Error('completion failed')),
          };
        }

        return {
          eq: jest.fn().mockResolvedValue({ error: null }),
        };
      }),
    });

    const makePlansTable = () => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            plan_type: 'waterfall',
            start_date: null,
            end_date: null,
            budget: null,
            currency: 'EUR',
            description: null,
            updated_at: '2026-05-10T00:00:00.000Z',
          },
          error: null,
        }),
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    });

    const from = jest.fn((table: string) => {
      if (table === 'plan_ai_generations') return makePlanAiGenerationsTable();
      if (table === 'plans') return makePlansTable();
      if (table === 'users') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'organization_members') {
        // People resolution now joins users via organization_members.
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'plan_risks') {
        return {
          delete: jest.fn().mockReturnValue({
            in: planRiskDeleteIn,
          }),
        };
      }
      if (table === 'task_relationships') {
        return {
          delete: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'plan_tasks') {
        return {
          delete: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'tasks') {
        return {
          update: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
          delete: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const addItem = jest
      .fn()
      .mockResolvedValueOnce({
        data: { id: 'phase-task-1', plan_task_id: 'plan-task-1' },
      })
      .mockResolvedValueOnce({
        data: { id: 'wp-task-1', plan_task_id: 'plan-task-2' },
      })
      .mockResolvedValueOnce({
        data: { id: 'task-1', plan_task_id: 'plan-task-3' },
      });

    const service = new PlansAiService(
      { getClient: jest.fn(() => ({ from })) } as never,
      {
        assertCanEditPlan: jest.fn().mockResolvedValue({ id: 'plan-1' }),
        addItem,
        addRisk: jest.fn().mockResolvedValue({
          data: {
            id: 'risk-1',
          },
          success: true,
        }),
      } as never,
    );

    await expect(
      service.executePlan('plan-1', 'org-1', 'user-1', 'generation-1'),
    ).rejects.toThrow('completion failed');

    expect(planRiskDeleteIn).toHaveBeenCalledWith('id', ['risk-1']);
  });
});

describe('PlansAiService generated plan validation', () => {
  const makeValidGeneratedPlan = () => ({
    plan_name: 'Generated plan',
    plan_description: 'Generated plan description',
    plan_type: 'waterfall',
    start_date: '2026-06-01',
    end_date: '2026-06-30',
    phases: [
      {
        name: 'Phase 1',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        children: [
          {
            name: 'Work package 1',
            start_date: '2026-06-01',
            end_date: '2026-06-15',
            children: [
              {
                name: 'Task 1',
                item_type: 'task',
                start_date: '2026-06-01',
                end_date: '2026-06-05',
                priority: 'medium',
              },
            ],
          },
        ],
      },
    ],
    stakeholders: [],
    risks: [],
    people: [],
    dependencies: [],
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects provider JSON with invalid generated plan fields before returning it', async () => {
    const service = new PlansAiService(
      { getClient: jest.fn() } as never,
      {} as never,
    );
    const invalidPlan = makeValidGeneratedPlan();
    invalidPlan.risks = [
      {
        name: 'Upside',
        risk_type: 'upside',
        probability: 3,
        impact: 4,
      } as never,
    ];

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        usage: { prompt_tokens: 5, completion_tokens: 10 },
        choices: [{ message: { content: JSON.stringify(invalidPlan) } }],
      }),
    } as never);

    await expect(
      (
        service as unknown as {
          callAiProvider: (
            provider: string,
            apiKey: string,
            prompt: string,
          ) => Promise<unknown>;
        }
      ).callAiProvider('openai', 'api-key', 'Make a plan'),
    ).rejects.toThrow(
      'AI generated plan failed validation: risks.0.risk_type: Invalid option: expected one of "risk"|"opportunity"',
    );
  });

  it('accepts frontend-compatible nullable structured output fields', () => {
    const service = new PlansAiService(
      { getClient: jest.fn() } as never,
      {} as never,
    );
    const nullablePlan = makeValidGeneratedPlan();
    nullablePlan.budget = null as never;
    nullablePlan.phases[0].description = null as never;
    nullablePlan.phases[0].children[0].description = null as never;
    nullablePlan.phases[0].children[0].children[0].description = null as never;
    nullablePlan.phases[0].children[0].children[0].assigned_to_email =
      null as never;
    nullablePlan.stakeholders = [
      {
        name: 'Sponsor',
        role: null,
        email: null,
        organization_name: null,
        power_level: 8,
        interest_level: 9,
        attitude: null,
        engagement_strategy: null,
      } as never,
    ];
    nullablePlan.risks = [
      {
        name: 'Risk',
        description: null,
        risk_type: 'risk',
        category: null,
        probability: 3,
        impact: 4,
        mitigation_strategy: null,
        contingency_plan: null,
      } as never,
    ];
    nullablePlan.people = [
      {
        name: 'Person',
        email: null,
        role: null,
        skills: null,
        availability_percentage: null,
      } as never,
    ];

    expect(
      (
        service as unknown as {
          validateGeneratedPlan: (
            value: unknown,
            label: 'AI generated plan',
          ) => unknown;
        }
      ).validateGeneratedPlan(nullablePlan, 'AI generated plan'),
    ).toMatchObject({ budget: null });
  });

  it('revalidates stored generated plans before locking execution', async () => {
    const lockUpdate = jest.fn();
    const from = jest.fn((table: string) => {
      if (table === 'plan_ai_generations') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'generation-1',
                status: 'completed',
                generated_plan: {
                  ...makeValidGeneratedPlan(),
                  phases: [],
                },
              },
              error: null,
            }),
          }),
          update: lockUpdate,
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const service = new PlansAiService(
      { getClient: jest.fn(() => ({ from })) } as never,
      {
        assertCanEditPlan: jest.fn().mockResolvedValue({ id: 'plan-1' }),
      } as never,
    );

    await expect(
      service.executePlan('plan-1', 'org-1', 'user-1', 'generation-1'),
    ).rejects.toThrow(
      'Stored AI generated plan failed validation: phases: Too small: expected array to have >=1 items',
    );
    expect(lockUpdate).not.toHaveBeenCalled();
  });

  it('returns compatible errors for non-fatal dependency skips', async () => {
    const completedPatch = jest.fn();
    let planUpdatePatch: Record<string, unknown> | null = null;
    const generatedPlan = makeValidGeneratedPlan();
    generatedPlan.budget = 0 as never;
    generatedPlan.dependencies = [
      {
        predecessor_name: 'Task 1',
        successor_name: 'Missing task',
        dependency_type: 'finish_to_start',
      },
    ];

    const makePlanAiGenerationsTable = () => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data: {
            id: 'generation-1',
            status: 'completed',
            provider_name: 'test-provider',
            generated_plan: generatedPlan,
          },
          error: null,
        }),
      }),
      update: jest.fn((patch: Record<string, unknown>) => {
        if (patch['execution_status'] === 'executing') {
          return {
            eq: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            maybeSingle: jest
              .fn()
              .mockResolvedValue({ data: { id: 'generation-1' }, error: null }),
          };
        }

        if (patch['execution_status'] === 'completed') {
          completedPatch(patch);
        }

        return {
          eq: jest.fn().mockResolvedValue({ error: null }),
        };
      }),
    });

    const makePlansTable = () => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            plan_type: 'waterfall',
            start_date: null,
            end_date: null,
            budget: null,
            currency: 'EUR',
            description: null,
            updated_at: '2026-05-10T00:00:00.000Z',
          },
          error: null,
        }),
      }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    });

    const from = jest.fn((table: string) => {
      if (table === 'plan_ai_generations') return makePlanAiGenerationsTable();
      if (table === 'plans') return makePlansTable();
      if (table === 'users') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'organization_members') {
        // People resolution now joins users via organization_members.
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'ai_usage_logs') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const makePlansTableWithCapturedUpdate = () => {
      const table = makePlansTable();
      table.update = jest.fn((patch: Record<string, unknown>) => {
        planUpdatePatch = patch;
        return {
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        };
      });
      return table;
    };

    from.mockImplementation((table: string) => {
      if (table === 'plan_ai_generations') return makePlanAiGenerationsTable();
      if (table === 'plans') return makePlansTableWithCapturedUpdate();
      if (table === 'users') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'organization_members') {
        // People resolution now joins users via organization_members.
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ data: [] }),
          }),
        };
      }
      if (table === 'ai_usage_logs') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const addItem = jest
      .fn()
      .mockResolvedValueOnce({
        data: { id: 'phase-task-1', plan_task_id: 'plan-task-1' },
      })
      .mockResolvedValueOnce({
        data: { id: 'wp-task-1', plan_task_id: 'plan-task-2' },
      })
      .mockResolvedValueOnce({
        data: { id: 'task-1', plan_task_id: 'plan-task-3' },
      });

    const service = new PlansAiService(
      { getClient: jest.fn(() => ({ from })) } as never,
      {
        assertCanEditPlan: jest.fn().mockResolvedValue({ id: 'plan-1' }),
        addItem,
      } as never,
    );

    await expect(
      service.executePlan('plan-1', 'org-1', 'user-1', 'generation-1'),
    ).resolves.toMatchObject({
      dependencies_created: 0,
      errors: [
        {
          type: 'dependency',
          message:
            'Skipped dependency from "Task 1" to "Missing task" because one or both tasks could not be resolved.',
        },
      ],
    });
    expect(completedPatch).toHaveBeenCalledWith(
      expect.objectContaining({ execution_status: 'completed' }),
    );
    expect(planUpdatePatch).toEqual(expect.objectContaining({ budget: 0 }));
  });
});
