import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createDecipheriv } from 'crypto';
import { z } from 'zod';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PlansService } from './plans.service';
import { PlanItemType } from './dto/create-plan-item.dto';

const SYSTEM_PROMPT = `You are an expert project manager and planner. Your task is to create a detailed, structured project plan based on the user's description.

You MUST respond with ONLY valid JSON that matches the following schema exactly. Do not include any text before or after the JSON.

The JSON structure must be:
{
  "plan_name": "string (required)",
  "plan_description": "string (required)",
  "plan_type": "waterfall|agile|hybrid|ipma",
  "start_date": "YYYY-MM-DD (ISO date, required)",
  "end_date": "YYYY-MM-DD (ISO date, required)",
  "budget": number (optional, in base currency units),
  "currency": "string (3-letter ISO code, default EUR)",
  "phases": [
    {
      "name": "string (required)",
      "description": "string",
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD",
      "item_type": "phase",
      "children": [
        {
          "name": "string (required)",
          "description": "string",
          "item_type": "work_package",
          "start_date": "YYYY-MM-DD",
          "end_date": "YYYY-MM-DD",
          "duration_days": number,
          "children": [
            {
              "name": "string (required)",
              "description": "string",
              "item_type": "task|milestone",
              "start_date": "YYYY-MM-DD",
              "end_date": "YYYY-MM-DD",
              "duration_days": number,
              "priority": "highest|high|medium|low|lowest",
              "estimated_hours": number,
              "estimated_cost": number,
              "assigned_to_name": "string (person name from people list)",
              "assigned_to_email": "string (person email from people list)"
            }
          ]
        }
      ]
    }
  ],
  "stakeholders": [
    {
      "name": "string (required)",
      "role": "string",
      "email": "string",
      "organization_name": "string",
      "power_level": number (1-10),
      "interest_level": number (1-10),
      "attitude": "supportive|neutral|resistant",
      "notes": "string",
      "engagement_strategy": "string"
    }
  ],
  "risks": [
    {
      "name": "string (required)",
      "description": "string",
      "risk_type": "risk|opportunity",
      "category": "string (e.g. Technical, Schedule, Budget, Resource, Organizational, External)",
      "probability": number (1-5),
      "impact": number (1-5),
      "mitigation_strategy": "string",
      "contingency_plan": "string"
    }
  ],
  "people": [
    {
      "name": "string (required)",
      "email": "string",
      "role": "string",
      "skills": "string (comma-separated skills)",
      "availability_percentage": number (0-100)
    }
  ],
  "dependencies": [
    {
      "predecessor_name": "string (exact task name)",
      "successor_name": "string (exact task name)",
      "dependency_type": "finish_to_start|start_to_start|finish_to_finish|start_to_finish",
      "lag_days": number (0 for immediate, negative for lead time)
    }
  ]
}

Rules:
1. ALWAYS use ISO date format YYYY-MM-DD for all dates
2. phases array must have at least 1 phase
3. Each phase must have at least 1 child (work_package)
4. Each work_package must have at least 1 child (task or milestone)
5. Use priority: highest, high, medium, low, or lowest only
6. Risk probability and impact must be integers 1-5
7. Stakeholder power_level and interest_level must be integers 1-10
8. Dependency types: finish_to_start, start_to_start, finish_to_finish, start_to_finish
9. Task names in dependencies must match task names in the phases structure exactly
10. Provide realistic time estimates in hours
11. Identify all major stakeholders with power/interest analysis
12. Identify top 5-10 risks with mitigation strategies
13. Create a logical WBS structure: Phases -> Work Packages (children) -> Tasks/Milestones (children)
14. Milestones have zero duration (start_date = end_date)
15. Budget should be in the specified currency's base units (e.g., euros not cents)
16. Default currency is EUR
17. risk_type must be "risk" or "opportunity" only`;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const nullableString = z.string().nullable().optional();
const nullableIsoDate = z
  .string()
  .regex(ISO_DATE_RE, 'Expected YYYY-MM-DD date')
  .nullable()
  .optional();
const nullableNonNegativeNumber = z.number().min(0).nullable().optional();
const nullableEmail = z.string().email().nullable().optional();

function omitNull<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

const generatedTaskSchema = z
  .object({
    name: z.string().trim().min(1),
    description: nullableString,
    item_type: z.enum(['task', 'milestone']).default('task'),
    start_date: nullableIsoDate,
    end_date: nullableIsoDate,
    duration_days: nullableNonNegativeNumber,
    priority: z
      .enum(['highest', 'high', 'medium', 'low', 'lowest'])
      .nullable()
      .optional(),
    estimated_hours: nullableNonNegativeNumber,
    estimated_cost: nullableNonNegativeNumber,
    assigned_to_name: nullableString,
    assigned_to_email: nullableEmail,
  })
  .passthrough()
  .superRefine((task, ctx) => {
    if (
      task.item_type === 'milestone' &&
      task.start_date &&
      task.end_date &&
      task.start_date !== task.end_date
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_date'],
        message: 'Milestones must have matching start_date and end_date',
      });
    }
  });

const generatedWorkPackageSchema = z
  .object({
    name: z.string().trim().min(1),
    description: nullableString,
    item_type: z
      .enum(['work_package', 'task', 'milestone'])
      .nullable()
      .optional(),
    start_date: nullableIsoDate,
    end_date: nullableIsoDate,
    duration_days: nullableNonNegativeNumber,
    estimated_hours: nullableNonNegativeNumber,
    estimated_cost: nullableNonNegativeNumber,
    priority: z
      .enum(['highest', 'high', 'medium', 'low', 'lowest'])
      .nullable()
      .optional(),
    assigned_to_name: nullableString,
    assigned_to_email: nullableEmail,
    children: z.array(generatedTaskSchema).min(1),
  })
  .passthrough();

const generatedPhaseSchema = z
  .object({
    name: z.string().trim().min(1),
    description: nullableString,
    item_type: z.literal('phase').nullable().optional(),
    start_date: nullableIsoDate,
    end_date: nullableIsoDate,
    children: z.array(generatedWorkPackageSchema).min(1),
  })
  .passthrough();

export const generatedStakeholderSchema = z
  .object({
    name: z.string().trim().min(1),
    role: nullableString,
    email: nullableEmail,
    organization_name: nullableString,
    power_level: z.number().int().min(1).max(10).optional(),
    interest_level: z.number().int().min(1).max(10).optional(),
    attitude: z
      .enum(['supportive', 'neutral', 'resistant'])
      .nullable()
      .optional(),
    notes: nullableString,
    engagement_strategy: nullableString,
  })
  .passthrough();

export const generatedRiskSchema = z
  .object({
    name: z.string().trim().min(1),
    description: nullableString,
    risk_type: z.enum(['risk', 'opportunity']).default('risk'),
    category: nullableString,
    probability: z.number().int().min(1).max(5).optional(),
    impact: z.number().int().min(1).max(5).optional(),
    mitigation_strategy: nullableString,
    contingency_plan: nullableString,
  })
  .passthrough();

const generatedPersonSchema = z
  .object({
    name: z.string().trim().min(1),
    email: nullableEmail,
    role: nullableString,
    skills: nullableString,
    availability_percentage: z.number().min(0).max(100).nullable().optional(),
  })
  .passthrough();

export const generatedDependencySchema = z
  .object({
    predecessor_name: z.string().trim().min(1),
    successor_name: z.string().trim().min(1),
    dependency_type: z
      .enum([
        'finish_to_start',
        'start_to_start',
        'finish_to_finish',
        'start_to_finish',
      ])
      .default('finish_to_start'),
    lag_days: z.number().int().default(0),
  })
  .passthrough();

const generatedPlanSchema = z
  .object({
    plan_name: z.string().trim().min(1),
    plan_description: z.string().trim().min(1),
    plan_type: z.enum(['waterfall', 'agile', 'hybrid', 'ipma']),
    start_date: z.string().regex(ISO_DATE_RE, 'Expected YYYY-MM-DD date'),
    end_date: z.string().regex(ISO_DATE_RE, 'Expected YYYY-MM-DD date'),
    budget: nullableNonNegativeNumber,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Expected 3-letter uppercase ISO currency code')
      .default('EUR'),
    phases: z.array(generatedPhaseSchema).min(1),
    stakeholders: z.array(generatedStakeholderSchema).default([]),
    risks: z.array(generatedRiskSchema).default([]),
    people: z.array(generatedPersonSchema).default([]),
    dependencies: z.array(generatedDependencySchema).default([]),
  })
  .passthrough()
  .superRefine((plan, ctx) => {
    if (plan.start_date > plan.end_date) {
      ctx.addIssue({
        code: 'custom',
        path: ['end_date'],
        message: 'end_date must be on or after start_date',
      });
    }
  });

interface AiProviderConfig {
  provider_name: string;
  encrypted_api_key: string;
  encryption_iv: string;
  encryption_tag: string;
}

interface GeneratedPlan {
  plan_name: string;
  plan_description: string;
  plan_type: string;
  start_date: string;
  end_date: string;
  budget?: number | null;
  currency?: string;
  phases: GeneratedPhase[];
  stakeholders: GeneratedStakeholder[];
  risks: GeneratedRisk[];
  people: GeneratedPerson[];
  dependencies: GeneratedDependency[];
}

interface GeneratedPhase {
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  children: GeneratedWorkPackage[];
}

interface GeneratedWorkPackage {
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  duration_days?: number | null;
  estimated_hours?: number | null;
  estimated_cost?: number | null;
  priority?: string | null;
  assigned_to_name?: string | null;
  assigned_to_email?: string | null;
  children: GeneratedTask[];
}

interface GeneratedTask {
  name: string;
  description?: string | null;
  item_type?: string;
  start_date?: string | null;
  end_date?: string | null;
  duration_days?: number | null;
  priority?: string | null;
  estimated_hours?: number | null;
  estimated_cost?: number | null;
  assigned_to_name?: string | null;
  assigned_to_email?: string | null;
}

interface GeneratedStakeholder {
  name: string;
  role?: string | null;
  email?: string | null;
  organization_name?: string | null;
  power_level?: number;
  interest_level?: number;
  attitude?: string | null;
  notes?: string | null;
  engagement_strategy?: string | null;
}

interface GeneratedRisk {
  name: string;
  description?: string | null;
  risk_type?: string;
  category?: string | null;
  probability?: number;
  impact?: number;
  mitigation_strategy?: string | null;
  contingency_plan?: string | null;
}

interface GeneratedPerson {
  name: string;
  email?: string | null;
  role?: string | null;
  skills?: string | null;
  availability_percentage?: number | null;
}

interface GeneratedDependency {
  predecessor_name: string;
  successor_name: string;
  dependency_type?: string;
  lag_days?: number;
}

interface PlanExecutionError {
  type: 'dependency';
  message: string;
}

@Injectable()
export class PlansAiService {
  private readonly logger = new Logger(PlansAiService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly plansService: PlansService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private getEncryptionKey(): Buffer {
    const secret = process.env['AI_ENCRYPTION_SECRET'];
    if (!secret || secret.length !== 64) {
      throw new InternalServerErrorException(
        'AI_ENCRYPTION_SECRET env var must be a 64-char hex string',
      );
    }
    return Buffer.from(secret, 'hex');
  }

  private decryptKey(encrypted: string, iv: string, tag: string): string {
    const key = this.getEncryptionKey();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  }

  private validateGeneratedPlan(
    value: unknown,
    label: 'AI generated plan' | 'Stored AI generated plan',
  ): GeneratedPlan {
    const result = generatedPlanSchema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => {
          const field = issue.path.length > 0 ? issue.path.join('.') : 'plan';
          return `${field}: ${issue.message}`;
        })
        .join('; ');
      throw new BadRequestException(`${label} failed validation: ${issues}`);
    }

    return result.data as GeneratedPlan;
  }

  private async cleanupFailedExecution(params: {
    planId: string;
    createdPlanTaskIds: string[];
    createdTaskIds: string[];
    createdStakeholderIds: string[];
    createdRiskIds: string[];
    createdDependencyIds: string[];
    originalPlan: Record<string, unknown> | null;
  }): Promise<void> {
    const unique = (values: string[]) => [...new Set(values)];
    const createdTaskIds = unique(params.createdTaskIds);
    const createdPlanTaskIds = unique(params.createdPlanTaskIds);

    if (params.createdDependencyIds.length > 0) {
      await this.client
        .from('task_relationships')
        .delete()
        .in('id', unique(params.createdDependencyIds));
    }

    if (createdTaskIds.length > 0) {
      await this.client
        .from('task_relationships')
        .delete()
        .eq('source_type', 'task')
        .in('source_id', createdTaskIds);
      await this.client
        .from('task_relationships')
        .delete()
        .eq('target_type', 'task')
        .in('target_id', createdTaskIds);
    }

    if (params.createdStakeholderIds.length > 0) {
      await this.client
        .from('plan_stakeholders')
        .delete()
        .in('id', unique(params.createdStakeholderIds));
    }

    if (params.createdRiskIds.length > 0) {
      await this.client
        .from('plan_risks')
        .delete()
        .in('id', unique(params.createdRiskIds));
    }

    if (createdPlanTaskIds.length > 0) {
      await this.client
        .from('plan_tasks')
        .delete()
        .in('id', createdPlanTaskIds);
    }

    if (createdTaskIds.length > 0) {
      await this.client
        .from('tasks')
        .update({ parent_task_id: null })
        .in('id', createdTaskIds);
      await this.client.from('tasks').delete().in('id', createdTaskIds);
    }

    if (params.originalPlan) {
      await this.client
        .from('plans')
        .update({
          plan_type: params.originalPlan['plan_type'] ?? null,
          start_date: params.originalPlan['start_date'] ?? null,
          end_date: params.originalPlan['end_date'] ?? null,
          budget: params.originalPlan['budget'] ?? null,
          currency: params.originalPlan['currency'] ?? null,
          description: params.originalPlan['description'] ?? null,
          updated_at:
            params.originalPlan['updated_at'] ?? new Date().toISOString(),
        })
        .eq('id', params.planId);
    }
  }

  async generatePlan(
    planId: string,
    organizationId: string,
    userId: string,
    spaceId: string,
    prompt: string,
  ): Promise<Record<string, unknown>> {
    const plan = await this.plansService.assertCanEditPlan(
      planId,
      organizationId,
      userId,
    );
    if (String(plan['space_id']) !== spaceId) {
      throw new BadRequestException('Plan space mismatch');
    }

    // Get AI config
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: configRow, error: configError } = await this.client
      .from('ai_provider_configs')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .maybeSingle();

    if (configError)
      throw new InternalServerErrorException(configError.message);
    if (!configRow)
      throw new BadRequestException(
        'No AI provider configured. Please configure an AI provider first.',
      );

    const config = configRow as unknown as AiProviderConfig;
    const apiKey = this.decryptKey(
      config.encrypted_api_key,
      config.encryption_iv,
      config.encryption_tag,
    );

    // Create generation record
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: generation, error: genError } = await this.client
      .from('plan_ai_generations')
      .insert({
        plan_id: planId,
        organization_id: organizationId,
        space_id: spaceId,
        user_id: userId,
        prompt_text: prompt,
        provider_name: config.provider_name,
        status: 'pending',
        execution_status: 'not_executed',
      })
      .select()
      .single();

    if (genError) throw new InternalServerErrorException(genError.message);
    const genRow = generation as unknown as Record<string, unknown>;
    const generationId = genRow['id'] as string;

    // Update status to generating
    await this.client
      .from('plan_ai_generations')
      .update({ status: 'generating' })
      .eq('id', generationId);

    let generatedPlan: GeneratedPlan;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let modelUsed = '';

    try {
      const result = await this.callAiProvider(
        config.provider_name,
        apiKey,
        prompt,
      );
      generatedPlan = result.plan;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      totalTokens = result.totalTokens;
      modelUsed = result.model;
    } catch (err) {
      const safeMsg =
        err instanceof Error ? err.message.slice(0, 500) : 'Unknown error';
      await this.client
        .from('plan_ai_generations')
        .update({ status: 'failed', error_message: safeMsg })
        .eq('id', generationId);
      throw err;
    }

    // Update generation record with result
    await this.client
      .from('plan_ai_generations')
      .update({
        status: 'completed',
        generated_plan: generatedPlan as unknown as Record<string, unknown>,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        model_name: modelUsed,
      })
      .eq('id', generationId);

    // Log usage. Must be awaited: supabase-js query builders are lazy thenables —
    // a bare `void insert(...)` never sends the request. Non-blocking on failure
    // (warn, never throw) so logging can't break generation.
    const { error: usageError } = await this.client
      .from('ai_usage_logs')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        operation_type: 'plan_generation',
        provider_name: config.provider_name,
        tokens_used: totalTokens,
        metadata: { plan_id: planId, generation_id: generationId },
      });

    if (usageError) {
      this.logger.warn(
        `AI usage logging failed (plan_generation): ${usageError.message}`,
      );
    }

    return {
      generation_id: generationId,
      generated_plan: generatedPlan,
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
      provider: config.provider_name,
      model: modelUsed,
    };
  }

  private async callAiProvider(
    provider: string,
    apiKey: string,
    prompt: string,
  ): Promise<{
    plan: GeneratedPlan;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
  }> {
    let responseText: string;
    let promptTokens = 0;
    let completionTokens = 0;
    let model = '';

    if (provider === 'anthropic') {
      model = 'claude-sonnet-4-6';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(
          `[PlansAiService] Anthropic error [${res.status}]: ${errText}`,
        );
        throw new BadRequestException(
          'AI provider request failed. Please try again.',
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['input_tokens'] ?? 0;
      completionTokens = usage?.['output_tokens'] ?? 0;
      const content = json['content'] as
        | { type: string; text: string }[]
        | undefined;
      responseText = content?.find((c) => c.type === 'text')?.text ?? '';
    } else if (provider === 'openai') {
      model = 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(
          `[PlansAiService] OpenAI error [${res.status}]: ${errText}`,
        );
        throw new BadRequestException(
          'AI provider request failed. Please try again.',
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['prompt_tokens'] ?? 0;
      completionTokens = usage?.['completion_tokens'] ?? 0;
      const choices = json['choices'] as
        | { message: { content: string } }[]
        | undefined;
      responseText = choices?.[0]?.message.content ?? '';
    } else if (provider === 'google') {
      model = 'gemini-1.5-flash';
      const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(googleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(
          `[PlansAiService] Google AI error [${res.status}]: ${errText}`,
        );
        throw new BadRequestException(
          'AI provider request failed. Please try again.',
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const usage = json['usageMetadata'] as Record<string, number> | undefined;
      promptTokens = usage?.['promptTokenCount'] ?? 0;
      completionTokens = usage?.['candidatesTokenCount'] ?? 0;
      const candidates = json['candidates'] as
        | { content: { parts: { text: string }[] } }[]
        | undefined;
      responseText = candidates?.[0]?.content.parts[0]?.text ?? '';
    } else if (provider === 'mistral') {
      model = 'mistral-small-latest';
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(
          `[PlansAiService] Mistral error [${res.status}]: ${errText}`,
        );
        throw new BadRequestException(
          'AI provider request failed. Please try again.',
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['prompt_tokens'] ?? 0;
      completionTokens = usage?.['completion_tokens'] ?? 0;
      const choices = json['choices'] as
        | { message: { content: string } }[]
        | undefined;
      responseText = choices?.[0]?.message.content ?? '';
    } else {
      throw new BadRequestException(`Unsupported AI provider: ${provider}`);
    }

    let plan: GeneratedPlan;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText.trim();
      plan = JSON.parse(jsonText) as GeneratedPlan;
    } catch {
      throw new BadRequestException(
        'AI provider returned invalid JSON. Please try again.',
      );
    }

    if (!plan.plan_name || !plan.phases || plan.phases.length === 0) {
      throw new BadRequestException(
        'AI generated plan is missing required fields (plan_name, phases).',
      );
    }

    return {
      plan: this.validateGeneratedPlan(plan, 'AI generated plan'),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model,
    };
  }

  async executePlan(
    planId: string,
    organizationId: string,
    userId: string,
    generationId: string,
  ): Promise<Record<string, unknown>> {
    await this.plansService.assertCanEditPlan(planId, organizationId, userId);

    // Get generation record
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: genRow, error: genError } = await this.client
      .from('plan_ai_generations')
      .select('*')
      .eq('id', generationId)
      .eq('plan_id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (genError) throw new InternalServerErrorException(genError.message);
    if (!genRow) throw new NotFoundException('AI generation not found');

    const gen = genRow as unknown as Record<string, unknown>;

    if (gen['status'] !== 'completed') {
      throw new BadRequestException('Generation is not in completed status');
    }

    const generatedPlan = this.validateGeneratedPlan(
      gen['generated_plan'],
      'Stored AI generated plan',
    );

    // Atomic lock — only proceed if execution_status is not_executed or failed
    const { data: locked, error: lockError } = await this.client
      .from('plan_ai_generations')
      .update({ execution_status: 'executing' })
      .eq('id', generationId)
      .in('execution_status', ['not_executed', 'failed'])
      .select('id')
      .maybeSingle();

    if (lockError) throw new InternalServerErrorException(lockError.message);
    if (!locked) {
      throw new ConflictException(
        'Plan execution is already in progress or completed',
      );
    }

    let itemsCreated = 0;
    let stakeholdersCreated = 0;
    let risksCreated = 0;
    let dependenciesCreated = 0;
    const executionErrors: PlanExecutionError[] = [];
    const createdPlanTaskIds: string[] = [];
    const createdTaskIds: string[] = [];
    const createdStakeholderIds: string[] = [];
    const createdRiskIds: string[] = [];
    const createdDependencyIds: string[] = [];
    let originalPlan: Record<string, unknown> | null = null;

    try {
      const { data: originalPlanRow, error: originalPlanError } =
        await this.client
          .from('plans')
          .select(
            'plan_type, start_date, end_date, budget, currency, description, updated_at',
          )
          .eq('id', planId)
          .eq('organization_id', organizationId)
          .single();
      if (originalPlanError) {
        throw new InternalServerErrorException(originalPlanError.message);
      }
      originalPlan = originalPlanRow as unknown as Record<string, unknown>;

      // Update plan metadata
      const planUpdate: Record<string, unknown> = {};
      if (generatedPlan.plan_type)
        planUpdate['plan_type'] = generatedPlan.plan_type;
      if (generatedPlan.start_date)
        planUpdate['start_date'] = generatedPlan.start_date;
      if (generatedPlan.end_date)
        planUpdate['end_date'] = generatedPlan.end_date;
      if (generatedPlan.budget !== undefined && generatedPlan.budget !== null)
        planUpdate['budget'] = generatedPlan.budget;
      if (generatedPlan.currency)
        planUpdate['currency'] = generatedPlan.currency;
      if (generatedPlan.plan_description)
        planUpdate['description'] = generatedPlan.plan_description;
      planUpdate['updated_at'] = new Date().toISOString();

      const { error: planUpdateError } = await this.client
        .from('plans')
        .update(planUpdate)
        .eq('id', planId)
        .eq('organization_id', organizationId);
      if (planUpdateError) {
        throw new InternalServerErrorException(planUpdateError.message);
      }

      // Resolve people by email or name.
      // users.organization_id is gone — join via organization_members.
      const { data: memberRows } = await this.client
        .from('organization_members')
        .select('user_id, users:users!inner(id, first_name, last_name, email)')
        .eq('organization_id', organizationId);

      const orgUsers = (
        (memberRows ?? []) as Array<{
          users:
            | {
                id: string;
                first_name: string;
                last_name: string;
                email: string;
              }
            | Array<{
                id: string;
                first_name: string;
                last_name: string;
                email: string;
              }>;
        }>
      ).flatMap((row) =>
        Array.isArray(row.users) ? row.users : row.users ? [row.users] : [],
      );

      const users = orgUsers as unknown as {
        id: string;
        first_name: string;
        last_name: string;
        email: string;
      }[];

      const resolvePerson = (nameOrEmail: string): string | null => {
        const lower = nameOrEmail.toLowerCase();
        const byEmail = users.find((u) => u.email?.toLowerCase() === lower);
        if (byEmail) return byEmail.id;
        const byName = users.find(
          (u) =>
            `${u.first_name} ${u.last_name}`.toLowerCase() === lower ||
            u.first_name?.toLowerCase() === lower,
        );
        return byName?.id ?? null;
      };

      // Track task name → task_id for dependency resolution
      const taskNameToTaskId = new Map<string, string>();

      // Create items: phases → work_packages (children) → tasks (children)
      for (const phase of generatedPlan.phases ?? []) {
        const phaseResult = await this.plansService.addItem(
          planId,
          organizationId,
          userId,
          {
            name: phase.name,
            description: omitNull(phase.description),
            item_type: PlanItemType.PHASE,
            start_date: omitNull(phase.start_date),
            end_date: omitNull(phase.end_date),
          },
        );
        itemsCreated++;

        const phaseItem = phaseResult.data as unknown as {
          id: string;
          plan_task_id: string;
        };
        if (phaseItem.id) createdTaskIds.push(phaseItem.id);
        if (phaseItem.plan_task_id) {
          createdPlanTaskIds.push(phaseItem.plan_task_id);
        }

        for (const wp of phase.children ?? []) {
          const wpResult = await this.plansService.addItem(
            planId,
            organizationId,
            userId,
            {
              name: wp.name,
              description: omitNull(wp.description),
              item_type: PlanItemType.WORK_PACKAGE,
              start_date: omitNull(wp.start_date),
              end_date: omitNull(wp.end_date),
              duration_days: omitNull(wp.duration_days),
              parent_id: phaseItem.id,
            },
          );
          itemsCreated++;

          const wpItem = wpResult.data as unknown as {
            id: string;
            plan_task_id: string;
          };
          if (wpItem.id) createdTaskIds.push(wpItem.id);
          if (wpItem.plan_task_id) {
            createdPlanTaskIds.push(wpItem.plan_task_id);
          }

          for (const task of wp.children ?? []) {
            const assignedTo = task.assigned_to_email
              ? resolvePerson(task.assigned_to_email)
              : task.assigned_to_name
                ? resolvePerson(task.assigned_to_name)
                : null;

            const taskResult = await this.plansService.addItem(
              planId,
              organizationId,
              userId,
              {
                name: task.name,
                description: omitNull(task.description),
                item_type:
                  (task.item_type as PlanItemType) ?? PlanItemType.TASK,
                start_date: omitNull(task.start_date),
                end_date: omitNull(task.end_date),
                duration_days: omitNull(task.duration_days),
                priority: omitNull(task.priority) as never,
                estimated_hours: omitNull(task.estimated_hours),
                estimated_cost: omitNull(task.estimated_cost),
                assigned_to: assignedTo ?? undefined,
                parent_id: wpItem.id,
              },
            );
            itemsCreated++;

            const taskItem = taskResult.data as unknown as {
              id: string;
              plan_task_id: string;
            };
            if (taskItem.id) createdTaskIds.push(taskItem.id);
            if (taskItem.plan_task_id) {
              createdPlanTaskIds.push(taskItem.plan_task_id);
            }
            if (taskItem.id) {
              taskNameToTaskId.set(task.name, taskItem.id);
            }
          }
        }
      }

      // Resolve unresolved people
      const unresolvedPeople = (generatedPlan.people ?? []).map((p) => {
        const userId2 = p.email
          ? resolvePerson(p.email)
          : p.name
            ? resolvePerson(p.name)
            : null;
        return {
          name: p.name,
          email: p.email ?? null,
          role: p.role ?? null,
          skills: p.skills ?? null,
          availability_percentage: p.availability_percentage ?? null,
          user_id: userId2,
          resolved: !!userId2,
        };
      });

      // Create stakeholders
      for (const s of generatedPlan.stakeholders ?? []) {
        const resolvedUserId = s.email
          ? resolvePerson(s.email)
          : s.name
            ? resolvePerson(s.name)
            : null;
        const stakeholderResult = await this.plansService.addStakeholder(
          planId,
          organizationId,
          userId,
          {
            name: s.name,
            role: omitNull(s.role),
            email: omitNull(s.email),
            organization_name: omitNull(s.organization_name),
            user_id: resolvedUserId ?? undefined,
            power_level: s.power_level,
            interest_level: s.interest_level,
            attitude: omitNull(s.attitude) as never,
            notes: omitNull(s.notes),
            engagement_strategy: omitNull(s.engagement_strategy),
          },
        );
        const stakeholderId = stakeholderResult.data['id'];
        if (typeof stakeholderId === 'string') {
          createdStakeholderIds.push(stakeholderId);
        }
        stakeholdersCreated++;
      }

      // Create risks
      for (const r of generatedPlan.risks ?? []) {
        const riskResult = await this.plansService.addRisk(
          planId,
          organizationId,
          userId,
          {
            name: r.name,
            description: omitNull(r.description),
            risk_type: r.risk_type as never,
            category: omitNull(r.category),
            probability: r.probability,
            impact: r.impact,
            mitigation_strategy: omitNull(r.mitigation_strategy),
            contingency_plan: omitNull(r.contingency_plan),
          },
        );
        const riskId = riskResult.data['id'];
        if (typeof riskId === 'string') createdRiskIds.push(riskId);
        risksCreated++;
      }

      // Create dependencies
      for (const dep of generatedPlan.dependencies ?? []) {
        const predecessorId = taskNameToTaskId.get(dep.predecessor_name);
        const successorId = taskNameToTaskId.get(dep.successor_name);

        if (!predecessorId || !successorId) {
          executionErrors.push({
            type: 'dependency',
            message: `Skipped dependency from "${dep.predecessor_name}" to "${dep.successor_name}" because one or both tasks could not be resolved.`,
          });
          continue;
        }

        try {
          const dependencyResult = await this.plansService.addDependency(
            planId,
            organizationId,
            userId,
            {
              predecessor_id: predecessorId,
              successor_id: successorId,
              dependency_type: dep.dependency_type as never,
              lag_days: dep.lag_days,
            },
          );
          const dependencyId = dependencyResult.data['id'];
          if (typeof dependencyId === 'string') {
            createdDependencyIds.push(dependencyId);
          }
          dependenciesCreated++;
        } catch (err) {
          executionErrors.push({
            type: 'dependency',
            message: `Skipped dependency from "${dep.predecessor_name}" to "${dep.successor_name}" because dependency creation failed${
              err instanceof Error ? `: ${err.message}` : '.'
            }`,
          });
        }
      }

      // Mark execution complete
      await this.client
        .from('plan_ai_generations')
        .update({
          execution_status: 'completed',
          executed_at: new Date().toISOString(),
          items_created: itemsCreated,
          stakeholders_created: stakeholdersCreated,
          risks_created: risksCreated,
          dependencies_created: dependenciesCreated,
        })
        .eq('id', generationId);

      // Log usage. Must be awaited: supabase-js query builders are lazy thenables —
      // a bare `void insert(...)` never sends the request. Non-blocking on failure
      // (warn, never throw) so logging can't break execution.
      const { error: usageError } = await this.client
        .from('ai_usage_logs')
        .insert({
          organization_id: organizationId,
          user_id: userId,
          operation_type: 'plan_execution',
          provider_name: gen['provider_name'] ?? 'unknown',
          tokens_used: 0,
          metadata: {
            plan_id: planId,
            generation_id: generationId,
            items_created: itemsCreated,
            stakeholders_created: stakeholdersCreated,
            risks_created: risksCreated,
            dependencies_created: dependenciesCreated,
          },
        });

      if (usageError) {
        this.logger.warn(
          `AI usage logging failed (plan_execution): ${usageError.message}`,
        );
      }

      return {
        items_created: itemsCreated,
        stakeholders_created: stakeholdersCreated,
        risks_created: risksCreated,
        dependencies_created: dependenciesCreated,
        unresolved_people: unresolvedPeople.filter((p) => !p.resolved),
        errors: executionErrors,
        plan_updated: true,
      };
    } catch (err) {
      try {
        await this.cleanupFailedExecution({
          planId,
          createdPlanTaskIds,
          createdTaskIds,
          createdStakeholderIds,
          createdRiskIds,
          createdDependencyIds,
          originalPlan,
        });
      } catch {
        // Best-effort cleanup; preserve the original execution error.
      }
      await this.client
        .from('plan_ai_generations')
        .update({
          execution_status: 'failed',
          error_message:
            err instanceof Error ? err.message.slice(0, 500) : 'Unknown error',
        })
        .eq('id', generationId);
      throw err;
    }
  }
}
