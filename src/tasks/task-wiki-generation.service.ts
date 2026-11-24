import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createDecipheriv, randomUUID } from 'crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { extractWikiPlainText } from '../wiki/wiki-content.util';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { GenerateWikiDto } from './dto/generate-wiki.dto';

const SYSTEM_PROMPT = `You are an expert technical writer generating rich wiki documentation from task data in EditorJS JSON format.

Return only a valid JSON object with this shape:
{ "title": "Page title", "blocks": [{ "type": "paragraph", "data": { "text": "..." } }] }

Use a polished structure with headers, paragraphs, lists, checklists, tables, callouts, quotes, toggles, and delimiters. Avoid markdown outside JSON. Use EditorJS block types only. List items must use { "content": "text", "items": [] }. Table cells must be strings.`;

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.0-flash',
  azure_openai: 'gpt-4o-mini',
  mistral: 'mistral-large-latest',
};

const ALLOWED_AI_WIKI_BLOCK_TYPES = new Set([
  'paragraph',
  'header',
  'list',
  'checklist',
  'table',
  'code',
  'quote',
  'warning',
  'alert',
  'notice',
  'toggle',
  'delimiter',
]);

const ALLOWED_ALIGNMENTS = new Set(['left', 'center', 'right']);
const ALLOWED_ALERT_TYPES = new Set([
  'primary',
  'secondary',
  'info',
  'success',
  'warning',
  'danger',
  'light',
  'dark',
]);
const ALLOWED_NOTICE_TYPES = new Set(['info', 'warning', 'error', 'success']);

interface AiConfigRow {
  provider_name: string;
  encrypted_api_key: string;
  encryption_iv: string;
  encryption_tag: string;
}

interface AiResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

interface EditorJsBlock {
  type: string;
  data: Record<string, unknown>;
}

interface AiWikiContent {
  title: string;
  blocks: EditorJsBlock[];
}

interface TaskContext {
  taskPrompt: string;
  taskTitle: string;
  spaceId: string;
  organizationId: string;
}

interface WikiPageResponse {
  id: string;
  title: string;
  slug: string;
}

@Injectable()
export class TaskWikiGenerationService {
  private readonly logger = new Logger(TaskWikiGenerationService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogsService: AuditLogsService,
    private readonly wikiPermissionsService: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async generateFromTask(
    taskId: string,
    user: RequestUser,
    dto: GenerateWikiDto,
  ): Promise<{
    wiki_page: WikiPageResponse;
    generation: {
      id: string;
      tokens_used: number;
      provider: string;
      model: string;
    };
  }> {
    const task = await this.getTaskBasic(taskId);

    if (task.organization_id !== user.organizationId) {
      throw new NotFoundException('Task not found');
    }

    const options = this.normalizeOptions(dto);

    await this.assertGenerationAccess(
      user,
      task.space_id,
      options.parent_page_id,
    );

    const aiConfig = await this.getAiConfig(user.organizationId);

    if (!aiConfig) {
      throw new BadRequestException(
        'AI provider not configured. Please configure an AI provider in Tenant Config -> AI Configuration.',
      );
    }

    const taskContext = await this.collectTaskContext(taskId, options);

    if (!taskContext.taskPrompt || taskContext.taskPrompt.trim().length < 20) {
      throw new BadRequestException(
        'Not enough task data to generate a wiki page. Please select more data sources or add content to the task.',
      );
    }

    const generation = await this.createGenerationRecord({
      organizationId: user.organizationId,
      spaceId: task.space_id,
      taskId,
      providerName: aiConfig.provider_name,
      modelName: this.getDefaultModel(aiConfig.provider_name),
      options,
      userId: user.userId,
    });

    try {
      await this.client
        .from('ai_generated_content')
        .update({ status: 'generating' })
        .eq('id', generation.id);

      const apiKey = this.decryptKey(
        aiConfig.encrypted_api_key,
        aiConfig.encryption_iv,
        aiConfig.encryption_tag,
      );

      const aiResponse = await this.callAiProvider(
        aiConfig.provider_name,
        apiKey,
        `Generate a comprehensive wiki documentation page from the following task data. Return ONLY a valid JSON object with "title" (string) and "blocks" (array of EditorJS blocks). No markdown, no explanation, ONLY the JSON.\n\n${taskContext.taskPrompt}`,
      );

      const aiContent = this.parseAiWikiContent(aiResponse.text);

      const editorJsContent = JSON.stringify({
        time: Date.now(),
        blocks: aiContent.blocks.map((block) => ({
          id: randomUUID().replace(/-/g, '').substring(0, 10),
          ...block,
        })),
        version: '2.31.2',
      });

      const wikiPage = await this.createWikiPage({
        spaceId: task.space_id,
        organizationId: user.organizationId,
        userId: user.userId,
        title: aiContent.title || `Wiki: ${task.summary}`,
        editorJsContent,
        generationId: generation.id,
        parentPageId: options.parent_page_id ?? null,
        taskId,
        taskKey: task.key || taskId,
      });

      await this.client
        .from('ai_generated_content')
        .update({
          status: 'completed',
          wiki_page_id: wikiPage.id,
          prompt_tokens: aiResponse.promptTokens,
          completion_tokens: aiResponse.completionTokens,
          total_tokens: aiResponse.totalTokens,
          completed_at: new Date().toISOString(),
        })
        .eq('id', generation.id);

      void this.logAiUsage({
        organizationId: user.organizationId,
        userId: user.userId,
        operationType: 'task_to_wiki',
        providerName: aiConfig.provider_name,
        tokensUsed: aiResponse.totalTokens,
        metadata: {
          task_id: taskId,
          task_key: task.key || taskId,
          wiki_page_id: wikiPage.id,
          generation_id: generation.id,
          model_name: aiResponse.model,
          blocks_count: aiContent.blocks.length,
          include_description: options.include_description,
          include_comments: options.include_comments,
          include_history: options.include_history,
          include_subtasks: options.include_subtasks,
        },
      });

      void this.auditLogsService.logAction(
        user.organizationId,
        user.userId,
        'wiki_page',
        wikiPage.id,
        'create',
        {
          action: 'task_to_wiki_generation',
          task_id: taskId,
          generation_id: generation.id,
          title: wikiPage.title,
          space_id: task.space_id,
        },
      );

      return {
        wiki_page: {
          id: wikiPage.id,
          title: wikiPage.title,
          slug: wikiPage.slug,
        },
        generation: {
          id: generation.id,
          tokens_used: aiResponse.totalTokens,
          provider: aiConfig.provider_name,
          model: aiResponse.model,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'AI generation failed';

      await this.client
        .from('ai_generated_content')
        .update({ status: 'failed', error_message: message })
        .eq('id', generation.id);

      void this.logAiUsage({
        organizationId: user.organizationId,
        userId: user.userId,
        operationType: 'task_to_wiki_failed',
        providerName: aiConfig.provider_name,
        tokensUsed: 0,
        metadata: {
          task_id: taskId,
          generation_id: generation.id,
          error: message,
        },
      });

      throw new InternalServerErrorException(
        `Wiki generation failed: ${message}. Please try again.`,
      );
    }
  }

  private normalizeOptions(dto: GenerateWikiDto): Required<GenerateWikiDto> {
    return {
      include_description: dto.include_description ?? false,
      include_comments: dto.include_comments ?? false,
      include_history: dto.include_history ?? false,
      include_subtasks: dto.include_subtasks ?? false,
      include_custom_fields: dto.include_custom_fields ?? false,
      include_attachments: dto.include_attachments ?? false,
      include_relationships: dto.include_relationships ?? false,
      parent_page_id: dto.parent_page_id ?? null,
    };
  }

  private async getTaskBasic(taskId: string): Promise<{
    id: string;
    key: string | null;
    space_id: string;
    organization_id: string;
    summary: string;
  }> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, key, space_id, organization_id, summary')
      .eq('id', taskId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Task not found');

    const task = data as Record<string, unknown>;
    if (typeof task['space_id'] !== 'string') {
      throw new BadRequestException('Task is not associated with a space');
    }

    return task as {
      id: string;
      key: string | null;
      space_id: string;
      organization_id: string;
      summary: string;
    };
  }

  private async assertGenerationAccess(
    user: RequestUser,
    spaceId: string,
    parentPageId?: string | null,
  ) {
    const permissions = await this.permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    if (
      !permissions.isMember ||
      permissions.permissions['view_space'] !== true ||
      permissions.permissions['view_tasks'] !== true ||
      permissions.permissions['create_wiki_pages'] !== true
    ) {
      throw new ForbiddenException('Permission denied');
    }

    if (parentPageId) {
      await this.wikiPermissionsService.assertPageAccess(
        parentPageId,
        user.userId,
        spaceId,
        'can_create',
      );
    }
  }

  private async getAiConfig(
    organizationId: string,
  ): Promise<AiConfigRow | null> {
    const aiResult = (await this.client
      .from('ai_provider_configs')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: AiConfigRow | null;
      error: { message: string } | null;
    };

    if (aiResult.error)
      throw new InternalServerErrorException(aiResult.error.message);
    return aiResult.data ?? null;
  }

  private getDefaultModel(provider: string): string {
    return DEFAULT_MODELS[provider] || 'unknown';
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

  private async collectTaskContext(
    taskId: string,
    options: Required<GenerateWikiDto>,
  ): Promise<TaskContext> {
    const { data: task, error: taskError } = await this.client
      .from('tasks')
      .select(
        `
        id, key, summary, description, status, priority,
        start_date, end_date, due_date, completed_at,
        progress, duration, estimated_time, actual_time,
        estimated_cost, actual_cost, custom_field_values, labels,
        space_id, organization_id, process_id, parent_task_id, task_type_id,
        assignee:users!tasks_assigned_to_fkey ( id, first_name, last_name, email ),
        reporter_user:users!tasks_reporter_fkey ( id, first_name, last_name, email )
      `,
      )
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      throw new NotFoundException(
        `Task not found: ${taskError?.message || 'Unknown error'}`,
      );
    }

    const row = task as Record<string, unknown>;
    const sections: string[] = [];
    const summary = this.toText(row['summary']) || 'Untitled task';

    sections.push(`# Task: ${summary}`);
    sections.push(`Key: ${this.toText(row['key']) || 'N/A'}`);
    sections.push(`Status: ${this.toText(row['status']) || 'N/A'}`);
    sections.push(`Priority: ${this.toText(row['priority']) || 'N/A'}`);

    this.appendPerson(sections, 'Assignee', row['assignee'], true);
    this.appendPerson(sections, 'Reporter', row['reporter_user'], false);

    for (const [label, field] of [
      ['Start Date', 'start_date'],
      ['End Date', 'end_date'],
      ['Due Date', 'due_date'],
      ['Completed At', 'completed_at'],
    ] as const) {
      const value = this.toText(row[field]);
      if (value) sections.push(`${label}: ${value}`);
    }

    if (row['progress'] != null)
      sections.push(`Progress: ${row['progress'] as string | number}%`);
    if (row['estimated_time'])
      sections.push(
        `Estimated Time: ${row['estimated_time'] as string | number} minutes`,
      );
    if (row['actual_time'])
      sections.push(
        `Actual Time: ${row['actual_time'] as string | number} minutes`,
      );
    if (row['estimated_cost'])
      sections.push(
        `Estimated Cost: ${row['estimated_cost'] as string | number}`,
      );
    if (row['actual_cost'])
      sections.push(`Actual Cost: ${row['actual_cost'] as string | number}`);

    if (options.include_description && row['description']) {
      sections.push('', '## Description', this.stripHtml(row['description']));
    }

    if (options.include_comments) {
      await this.appendComments(sections, taskId);
    }

    if (options.include_history) {
      await this.appendHistory(sections, taskId);
    }

    if (options.include_subtasks) {
      await this.appendSubtasks(sections, taskId);
    }

    if (options.include_custom_fields && row['custom_field_values']) {
      await this.appendCustomFields(
        sections,
        row['organization_id'] as string,
        row['custom_field_values'],
      );
    }

    if (options.include_attachments) {
      await this.appendAttachments(sections, taskId);
    }

    if (options.include_relationships) {
      await this.appendRelationships(sections, taskId);
    }

    const labels = row['labels'];
    if (Array.isArray(labels) && labels.length > 0) {
      sections.push(
        '',
        `Labels: ${labels.map((label) => String(label)).join(', ')}`,
      );
    }

    return {
      taskPrompt: sections.join('\n'),
      taskTitle: summary,
      spaceId: row['space_id'] as string,
      organizationId: row['organization_id'] as string,
    };
  }

  private async appendComments(sections: string[], taskId: string) {
    const { data } = await this.client
      .from('task_comments')
      .select(
        `
        id, content, created_at,
        author:users!task_comments_created_by_fkey ( first_name, last_name )
      `,
      )
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .limit(50);

    if (!data || data.length === 0) return;

    sections.push('', '## Comments');
    for (const comment of data as Record<string, unknown>[]) {
      const author = this.personName(comment['author']) || 'Unknown';
      const date = comment['created_at']
        ? new Date(comment['created_at'] as string).toLocaleDateString()
        : '';

      sections.push(
        `- [${date}] ${author}: ${this.stripHtml(comment['content'])}`,
      );
    }
  }

  private async appendHistory(sections: string[], taskId: string) {
    const { data } = await this.client
      .from('task_history')
      .select(
        `
        id, action, field_name, old_value, new_value, changed_at,
        changed_by_user:users!task_history_changed_by_fkey ( first_name, last_name )
      `,
      )
      .eq('task_id', taskId)
      .order('changed_at', { ascending: false })
      .limit(50);

    if (!data || data.length === 0) return;

    sections.push('', '## Change History');
    for (const entry of data as Record<string, unknown>[]) {
      const user = this.personName(entry['changed_by_user']) || 'System';
      const date = entry['changed_at']
        ? new Date(entry['changed_at'] as string).toLocaleDateString()
        : '';
      const fieldName = this.toText(entry['field_name']);

      if (fieldName) {
        sections.push(
          `- [${date}] ${user} changed ${fieldName}: "${this.toText(entry['old_value'])}" -> "${this.toText(entry['new_value'])}"`,
        );
      } else {
        sections.push(
          `- [${date}] ${user}: ${this.toText(entry['action']) || 'update'}`,
        );
      }
    }
  }

  private async appendSubtasks(sections: string[], taskId: string) {
    const { data } = await this.client
      .from('tasks')
      .select(
        `
        id, key, summary, status, priority, progress,
        assignee:users!tasks_assigned_to_fkey ( first_name, last_name )
      `,
      )
      .eq('parent_task_id', taskId)
      .order('sort_order', { ascending: true })
      .limit(100);

    if (!data || data.length === 0) return;

    sections.push('', '## Subtasks');
    for (const subtask of data as Record<string, unknown>[]) {
      const assignee = this.personName(subtask['assignee']);
      const suffix = assignee ? ` (${assignee})` : '';

      sections.push(
        `- [${this.toText(subtask['status']) || 'open'}] ${this.toText(subtask['key'])}: ${this.toText(subtask['summary'])}${suffix} - ${(subtask['progress'] as number | null) ?? 0}%`,
      );
    }
  }

  private async appendCustomFields(
    sections: string[],
    organizationId: string,
    customFieldValues: unknown,
  ) {
    const values =
      customFieldValues && typeof customFieldValues === 'object'
        ? (customFieldValues as Record<string, unknown>)
        : {};
    const entries = Object.entries(values).filter(
      ([, value]) => value != null && value !== '',
    );

    if (entries.length === 0) return;

    const { data: fields } = await this.client
      .from('custom_fields')
      .select('id, name, field_type')
      .eq('organization_id', organizationId);

    const fieldMap = new Map(
      ((fields ?? []) as Record<string, unknown>[]).map((field) => [
        String(field['id']),
        String(field['name']),
      ]),
    );

    sections.push('', '## Custom Fields');
    for (const [key, value] of entries) {
      sections.push(`- ${fieldMap.get(key) || key}: ${this.toText(value)}`);
    }
  }

  private async appendAttachments(sections: string[], taskId: string) {
    const { data } = await this.client
      .from('file_attachments')
      .select(
        `
        id, file_name, created_at,
        current_version:file_versions!file_attachments_current_version_fk(
          version_number, file_size, mime_type, uploaded_at, comment
        )
      `,
      )
      .eq('entity_type', 'task')
      .eq('entity_id', taskId)
      // A generated wiki page must not advertise an attachment that cannot be
      // downloaded.
      .not('current_version_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(50);

    if (!data || data.length === 0) return;

    sections.push('', '## Attachments');
    for (const attachment of data as Record<string, unknown>[]) {
      const version = attachment['current_version'] as
        | Record<string, unknown>
        | null
        | undefined;
      const rawSize =
        typeof version?.['file_size'] === 'number'
          ? version['file_size']
          : undefined;
      const fileSize =
        rawSize !== undefined
          ? `${Math.round(rawSize / 1024)}KB`
          : 'unknown size';
      const mimeType = this.toText(version?.['mime_type']) || 'file';
      const versionSuffix =
        typeof version?.['version_number'] === 'number'
          ? `, v${String(version['version_number'])}`
          : '';

      sections.push(
        `- ${this.toText(attachment['file_name'])} (${mimeType}, ${fileSize}${versionSuffix})`,
      );
    }
  }

  private async appendRelationships(sections: string[], taskId: string) {
    const { data } = await this.client
      .from('task_relationships')
      .select(
        `
        id, source_id, target_id, lag_days,
        relation_type:relation_types!task_relationships_relation_type_id_fkey ( name, outward_description, inward_description )
      `,
      )
      .or(`source_id.eq.${taskId},target_id.eq.${taskId}`)
      .limit(50);

    if (!data || data.length === 0) return;

    sections.push('', '## Relationships');
    for (const relationship of data as Record<string, unknown>[]) {
      const relationType = relationship['relation_type'] as
        | Record<string, unknown>
        | null
        | undefined;
      const isSource = relationship['source_id'] === taskId;
      const description = isSource
        ? this.toText(relationType?.['outward_description']) ||
          this.toText(relationType?.['name']) ||
          'relates to'
        : this.toText(relationType?.['inward_description']) ||
          this.toText(relationType?.['name']) ||
          'related from';
      const linkedId = isSource
        ? relationship['target_id']
        : relationship['source_id'];

      sections.push(`- ${description}: ${this.toText(linkedId)}`);
    }
  }

  private async createGenerationRecord(args: {
    organizationId: string;
    spaceId: string;
    taskId: string;
    providerName: string;
    modelName: string;
    options: Required<GenerateWikiDto>;
    userId: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('ai_generated_content')
      .insert({
        organization_id: args.organizationId,
        space_id: args.spaceId,
        source_type: 'task',
        source_id: args.taskId,
        content_format: 'editorjs',
        provider_name: args.providerName,
        model_name: args.modelName,
        status: 'pending',
        include_description: args.options.include_description,
        include_comments: args.options.include_comments,
        include_history: args.options.include_history,
        include_subtasks: args.options.include_subtasks,
        include_custom_fields: args.options.include_custom_fields,
        include_attachments: args.options.include_attachments,
        generated_by: args.userId,
      })
      .select('id')
      .single();

    if (error || !data) {
      this.logger.error('Failed to create task wiki generation record', error);
      throw new InternalServerErrorException(
        'Failed to initialize AI generation',
      );
    }

    return data as { id: string };
  }

  private async callAiProvider(
    provider: string,
    apiKey: string,
    prompt: string,
  ): Promise<AiResponse> {
    const model = this.getDefaultModel(provider);
    let responseText = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (provider === 'anthropic') {
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

      const json = await this.readAiResponse(res, 'Anthropic');
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['input_tokens'] ?? 0;
      completionTokens = usage?.['output_tokens'] ?? 0;
      const content = json['content'] as
        | Array<{ type?: string; text?: string }>
        | undefined;
      responseText = content?.find((item) => item.type === 'text')?.text ?? '';
    } else if (provider === 'openai' || provider === 'azure_openai') {
      const url =
        provider === 'azure_openai'
          ? this.buildAzureOpenAiUrl(model)
          : 'https://api.openai.com/v1/chat/completions';
      const headers: Record<string, string> =
        provider === 'azure_openai'
          ? { 'Content-Type': 'application/json', 'api-key': apiKey }
          : {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
      });

      const json = await this.readAiResponse(
        res,
        provider === 'azure_openai' ? 'Azure OpenAI' : 'OpenAI',
      );
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['prompt_tokens'] ?? 0;
      completionTokens = usage?.['completion_tokens'] ?? 0;
      const choices = json['choices'] as
        | Array<{ message?: { content?: string } }>
        | undefined;
      responseText = choices?.[0]?.message?.content ?? '';
    } else if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
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
        },
      );

      const json = await this.readAiResponse(res, 'Google AI');
      const usage = json['usageMetadata'] as Record<string, number> | undefined;
      promptTokens = usage?.['promptTokenCount'] ?? 0;
      completionTokens = usage?.['candidatesTokenCount'] ?? 0;
      const candidates = json['candidates'] as
        | Array<{ content?: { parts?: Array<{ text?: string }> } }>
        | undefined;
      responseText = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } else if (provider === 'mistral') {
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

      const json = await this.readAiResponse(res, 'Mistral');
      const usage = json['usage'] as Record<string, number> | undefined;
      promptTokens = usage?.['prompt_tokens'] ?? 0;
      completionTokens = usage?.['completion_tokens'] ?? 0;
      const choices = json['choices'] as
        | Array<{ message?: { content?: string } }>
        | undefined;
      responseText = choices?.[0]?.message?.content ?? '';
    } else {
      throw new BadRequestException(`Unsupported AI provider: ${provider}`);
    }

    return {
      text: responseText,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model,
    };
  }

  private buildAzureOpenAiUrl(model: string): string {
    const resourceName = process.env['AZURE_RESOURCE_NAME'];
    const apiVersion = process.env['AZURE_OPENAI_API_VERSION'] || '2024-10-21';

    if (!resourceName) {
      throw new BadRequestException(
        'Azure OpenAI requires AZURE_RESOURCE_NAME environment variable.',
      );
    }

    return `https://${resourceName}.openai.azure.com/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
  }

  private async readAiResponse(
    response: Response,
    providerLabel: string,
  ): Promise<Record<string, unknown>> {
    const text = await response.text();

    if (!response.ok) {
      this.logger.error(
        `[TaskWikiGenerationService] ${providerLabel} error [${response.status}]: ${text}`,
      );
      throw new BadRequestException(
        'AI provider request failed. Please try again.',
      );
    }

    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BadRequestException(
        'AI provider returned invalid JSON. Please try again.',
      );
    }
  }

  private parseAiWikiContent(text: string): AiWikiContent {
    const raw = text.trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonCandidate = fenced?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    let parsed: unknown;

    try {
      parsed = JSON.parse(jsonCandidate);
    } catch {
      throw new BadRequestException(
        'AI did not return valid JSON. Please try again.',
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException(
        'AI returned invalid content structure. Expected { title, blocks[] }.',
      );
    }

    const value = parsed as Record<string, unknown>;
    const title = this.toText(value['title']).trim();
    const blocks = Array.isArray(value['blocks'])
      ? value['blocks']
          .map((block) => this.normalizeBlock(block))
          .filter(Boolean)
      : [];

    if (!title || blocks.length === 0) {
      throw new BadRequestException(
        'AI returned invalid content structure. Expected { title, blocks[] }.',
      );
    }

    return { title, blocks: blocks as EditorJsBlock[] };
  }

  private normalizeBlock(block: unknown): EditorJsBlock | null {
    if (!block || typeof block !== 'object') return null;
    const source = block as Record<string, unknown>;
    const sourceType = this.toText(source['type']);
    const type = sourceType === 'nestedList' ? 'list' : sourceType;
    const sourceData =
      source['data'] && typeof source['data'] === 'object'
        ? { ...(source['data'] as Record<string, unknown>) }
        : null;

    if (!type || !sourceData || !ALLOWED_AI_WIKI_BLOCK_TYPES.has(type)) {
      return null;
    }

    const data = this.normalizeBlockData(type, sourceData);
    if (!data) {
      return null;
    }

    return { type, data };
  }

  private normalizeBlockData(
    type: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> | null {
    switch (type) {
      case 'paragraph': {
        const text = this.sanitizeInline(data['text']);
        return text ? { text } : null;
      }

      case 'header': {
        const text = this.sanitizeInline(data['text']);
        if (!text) return null;
        const rawLevel = Number(data['level']);
        const level = Number.isInteger(rawLevel)
          ? Math.min(Math.max(rawLevel, 1), 6)
          : 2;
        return { text, level };
      }

      case 'list': {
        const rawItems = Array.isArray(data['items']) ? data['items'] : [];
        const items = rawItems
          .map((item) => this.normalizeListItem(item))
          .filter(Boolean);
        if (items.length === 0) return null;
        return {
          items,
          style: data['style'] === 'ordered' ? 'ordered' : 'unordered',
        };
      }

      case 'checklist': {
        const rawItems = Array.isArray(data['items']) ? data['items'] : [];
        const items = rawItems
          .map((item) => this.normalizeChecklistItem(item))
          .filter(Boolean);
        return items.length > 0 ? { items } : null;
      }

      case 'table': {
        const rows = Array.isArray(data['content']) ? data['content'] : [];
        const content = rows
          .filter((row): row is unknown[] => Array.isArray(row))
          .map((row) => row.map((cell) => this.sanitizeInline(cell)))
          .filter((row) => row.length > 0);
        return content.length > 0
          ? { content, withHeadings: data['withHeadings'] !== false }
          : null;
      }

      case 'code': {
        const code = this.toText(data['code']);
        if (!code.trim()) return null;
        const language = this.toText(data['language']).trim().toLowerCase();
        return {
          code,
          language: /^[a-z0-9_+-]{1,30}$/i.test(language)
            ? language
            : 'plaintext',
        };
      }

      case 'quote': {
        const text = this.sanitizeInline(data['text']);
        if (!text) return null;
        const caption = this.sanitizeInline(data['caption']);
        const alignment = this.toAllowedValue(
          data['alignment'],
          ALLOWED_ALIGNMENTS,
          'left',
        );
        return caption ? { text, caption, alignment } : { text, alignment };
      }

      case 'warning': {
        const title = this.sanitizeInline(data['title']);
        const message = this.sanitizeInline(data['message']);
        return title || message ? { title, message } : null;
      }

      case 'alert': {
        const message = this.sanitizeInline(data['message']);
        if (!message) return null;
        return {
          message,
          type: this.toAllowedValue(data['type'], ALLOWED_ALERT_TYPES, 'info'),
          align: this.toAllowedValue(data['align'], ALLOWED_ALIGNMENTS, 'left'),
        };
      }

      case 'notice': {
        const title = this.sanitizeInline(data['title']);
        const message = this.sanitizeInline(data['message']);
        if (!title && !message) return null;
        return {
          title,
          message,
          type: this.toAllowedValue(data['type'], ALLOWED_NOTICE_TYPES, 'info'),
        };
      }

      case 'toggle': {
        const text = this.sanitizeInline(data['text']);
        return text
          ? { text, status: data['status'] === 'open' ? 'open' : 'closed' }
          : null;
      }

      case 'delimiter':
        return {};

      default:
        return null;
    }
  }

  private normalizeListItem(item: unknown): {
    content: string;
    items: Array<{ content: string; items: unknown[] }>;
  } | null {
    if (typeof item === 'string') {
      const content = this.sanitizeInline(item);
      return content ? { content, items: [] } : null;
    }
    if (!item || typeof item !== 'object') return null;

    const source = item as Record<string, unknown>;
    const content =
      this.sanitizeInline(source['content']) ||
      this.sanitizeInline(source['text']);
    if (!content) return null;

    const children = Array.isArray(source['items'])
      ? source['items']
          .map((child) => this.normalizeListItem(child))
          .filter(
            (
              child,
            ): child is {
              content: string;
              items: Array<{ content: string; items: unknown[] }>;
            } => Boolean(child),
          )
      : [];

    return { content, items: children };
  }

  private normalizeChecklistItem(
    item: unknown,
  ): { text: string; checked: boolean } | null {
    if (!item || typeof item !== 'object') return null;
    const source = item as Record<string, unknown>;
    const text = this.sanitizeInline(source['text']);
    return text ? { text, checked: source['checked'] === true } : null;
  }

  private sanitizeInline(value: unknown): string {
    return sanitizeRichText(this.toText(value)) ?? '';
  }

  private toAllowedValue(
    value: unknown,
    allowedValues: Set<string>,
    fallback: string,
  ): string {
    const text = this.toText(value).trim().toLowerCase();
    return allowedValues.has(text) ? text : fallback;
  }

  private async createWikiPage(args: {
    spaceId: string;
    organizationId: string;
    userId: string;
    title: string;
    editorJsContent: string;
    generationId: string;
    parentPageId: string | null;
    taskId: string;
    taskKey: string;
  }): Promise<WikiPageResponse> {
    const baseSlug =
      args.title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 180) || 'wiki-page';
    const slug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;
    let path: string[] = [];
    let level = 0;

    if (args.parentPageId) {
      const { data: parent } = await this.client
        .from('wiki_pages')
        .select('path, level, space_id, is_archived')
        .eq('id', args.parentPageId)
        .single();

      if (!parent) throw new BadRequestException('Parent page not found');

      const parentRow = parent as Record<string, unknown>;
      if (parentRow['space_id'] !== args.spaceId) {
        throw new BadRequestException(
          'Parent page must belong to the same space as the task',
        );
      }
      if (parentRow['is_archived']) {
        throw new BadRequestException(
          'Cannot create page under an archived parent',
        );
      }

      path = [...((parentRow['path'] as string[]) ?? []), args.parentPageId];
      level = ((parentRow['level'] as number) ?? 0) + 1;
      if (level > 10) {
        throw new BadRequestException(
          'Maximum wiki page nesting depth (10) exceeded',
        );
      }
    }

    const { data: page, error: pageError } = await this.client
      .from('wiki_pages')
      .insert({
        space_id: args.spaceId,
        organization_id: args.organizationId,
        title: args.title,
        slug,
        content: args.editorJsContent,
        content_format: 'editorjs',
        // Extract plain text so the page body feeds search_vector, and keep
        // workflow_status coherent with is_published (published, not draft).
        content_text: extractWikiPlainText(args.editorJsContent, 'editorjs'),
        workflow_status: 'published',
        parent_id: args.parentPageId,
        path,
        level,
        is_published: true,
        is_ai_generated: true,
        ai_generation_id: args.generationId,
        created_by: args.userId,
        updated_by: args.userId,
        tags: ['ai-generated'],
      })
      .select('id, title, slug')
      .single();

    if (pageError || !page) {
      throw new InternalServerErrorException(
        `Failed to create wiki page: ${pageError?.message || 'Unknown error'}`,
      );
    }

    const wikiPage = page as WikiPageResponse;
    const { error: linkError } = await this.client
      .from('wiki_page_links')
      .insert({
        source_page_id: wikiPage.id,
        target_type: 'task',
        target_id: args.taskId,
        target_metadata: {
          task_key: args.taskKey,
          task_title: args.title,
        },
        created_by: args.userId,
      });

    if (linkError) {
      this.logger.error(
        'Failed to link generated wiki page to task',
        linkError,
      );
    }

    return wikiPage;
  }

  private async logAiUsage(args: {
    organizationId: string;
    userId: string;
    operationType: string;
    providerName: string;
    tokensUsed: number;
    metadata: Record<string, unknown>;
  }) {
    const { error } = await this.client.from('ai_usage_logs').insert({
      organization_id: args.organizationId,
      user_id: args.userId,
      operation_type: args.operationType,
      provider_name: args.providerName,
      tokens_used: args.tokensUsed,
      metadata: args.metadata,
    });

    if (error) this.logger.warn(`AI usage logging failed: ${error.message}`);
  }

  private appendPerson(
    sections: string[],
    label: string,
    value: unknown,
    includeEmail: boolean,
  ) {
    const person = value as Record<string, unknown> | null | undefined;
    if (!person) return;

    const name = this.personName(person);
    if (!name) return;

    const email = includeEmail ? this.toText(person['email']) : '';
    sections.push(email ? `${label}: ${name} (${email})` : `${label}: ${name}`);
  }

  private personName(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const row = value as Record<string, unknown>;
    return [row['first_name'], row['last_name']]
      .map((part) => this.toText(part))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private stripHtml(value: unknown): string {
    return this.toText(value)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private toText(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return typeof value === 'object'
        ? '[object]'
        : String(value as string | number | boolean);
    }
  }
}
