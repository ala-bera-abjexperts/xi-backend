import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { encryptApiKey, decryptApiKey } from '../lib/crypto/encryption';
import {
  listGithubRepositories,
  listClickupLists,
  listTrelloLists,
  listAirtableBases,
  listAirtableTables,
  listJiraProjects,
  listJiraIssueTypes,
  listHubspotProperties,
  listSalesforceLeadFields,
  describeFetchFailure,
  type JiraProjectOption,
  type JiraIssueTypeOption,
  type CrmFieldOption,
  type GithubRepoOption,
  type ClickupListOption,
  type TrelloListOption,
  type AirtableBaseOption,
  type AirtableTableOption,
} from './integrations/issue-actions';
import {
  FormBuilderIntegrationDispatcherService,
  type IntegrationRow,
} from './form-builder-integration-dispatcher.service';
import type { CreateIntegrationDto } from './dto/create-integration.dto';
import type { UpdateIntegrationDto } from './dto/update-integration.dto';

const INTEGRATIONS_TABLE = 'form_builder_integrations';
const DELIVERIES_TABLE = 'form_builder_integration_deliveries';
const FORMS_TABLE = 'form_builder';

interface Ctx {
  spaceId: string;
  orgId: string;
}

// An integration row as returned to the client — the credential is NEVER returned (only hasCredential).
export interface IntegrationView {
  id: string;
  form_id: string;
  provider: string;
  config: Record<string, unknown>;
  field_map: unknown[];
  is_active: boolean;
  hasCredential: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// CRUD for native integrations (Gmail). The credential is encrypted at rest (encryptApiKey) and
// NEVER returned. Uses the service-role client (RLS bypassed) → every query scoped by org + space.
@Injectable()
export class FormBuilderIntegrationsService {
  private readonly logger = new Logger(FormBuilderIntegrationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly dispatcher: FormBuilderIntegrationDispatcherService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async create(
    formId: string,
    dto: CreateIntegrationDto,
    ctx: Ctx,
    userId: string,
  ): Promise<IntegrationView> {
    await this.assertForm(formId, ctx);

    const credentialCols = dto.credential?.trim()
      ? this.encryptCredential(dto.credential.trim())
      : {};

    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .insert({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        form_id: formId,
        provider: dto.provider,
        config: dto.config ?? {},
        field_map: dto.fieldMap ?? [],
        is_active: dto.isActive ?? true,
        created_by: userId,
        ...credentialCols,
      })
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    return this.toView(data as Record<string, unknown>);
  }

  async list(formId: string, ctx: Ctx): Promise<IntegrationView[]> {
    await this.assertForm(formId, ctx);

    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .select('*')
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []).map((r) => this.toView(r as Record<string, unknown>));
  }

  async update(
    formId: string,
    integrationId: string,
    dto: UpdateIntegrationDto,
    ctx: Ctx,
  ): Promise<IntegrationView> {
    await this.getOr404(formId, integrationId, ctx);

    const patch: Record<string, unknown> = {};

    if (dto.config !== undefined) patch.config = dto.config;
    if (dto.fieldMap !== undefined) patch.field_map = dto.fieldMap;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    // a provided non-empty credential re-encrypts; omitting it leaves the stored one untouched.
    if (dto.credential?.trim())
      Object.assign(patch, this.encryptCredential(dto.credential.trim()));

    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .update(patch)
      .eq('id', integrationId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    return this.toView(data as Record<string, unknown>);
  }

  async remove(formId: string, integrationId: string, ctx: Ctx) {
    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .delete()
      .eq('id', integrationId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Integration not found');

    return { success: true as const };
  }

  async sendTest(formId: string, integrationId: string, ctx: Ctx) {
    const integration = await this.getOr404(formId, integrationId, ctx);

    const result = await this.dispatcher.sendTest(integration);

    return {
      ok: result.ok,
      statusCode: result.status,
      issueUrl: result.externalRef,
      error: result.error,
    };
  }

  async listDeliveries(formId: string, integrationId: string, ctx: Ctx) {
    await this.getOr404(formId, integrationId, ctx);

    const { data, error } = await this.client
      .from(DELIVERIES_TABLE)
      .select(
        'id, event, status, attempt_count, response_code, last_error, external_ref, next_attempt_at, submission_id, created_at, updated_at',
      )
      .eq('integration_id', integrationId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // Repos for the dialog's picker. Uses the credential typed in the dialog; when omitted (editing)
  // falls back to this form's stored GitHub token.
  async listGithubRepos(
    formId: string,
    credential: string | undefined,
    ctx: Ctx,
  ): Promise<GithubRepoOption[]> {
    await this.assertForm(formId, ctx);

    const token =
      credential?.trim() || (await this.loadGithubCredential(formId, ctx));

    if (!token)
      throw new BadRequestException(
        'A GitHub token is required to list repositories',
      );

    try {
      return await listGithubRepositories(token);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load repositories',
      );
    }
  }

  // Resource pickers — mirror listGithubRepos: use the credential typed into the dialog so the
  // picker works while CREATING an integration; when omitted (edit mode) fall back to this form's
  // stored, decrypted credential for that provider.

  // Lists the connected ClickUp account's Lists for the list picker.
  async listClickupLists(
    formId: string,
    credential: string | undefined,
    ctx: Ctx,
  ): Promise<ClickupListOption[]> {
    await this.assertForm(formId, ctx);

    const token =
      credential?.trim() || (await this.loadClickupCredential(formId, ctx));

    if (!token)
      throw new BadRequestException(
        'A ClickUp token is required to list Lists',
      );

    try {
      return await listClickupLists(token);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load ClickUp lists',
      );
    }
  }

  // Lists the connected Trello account's Lists (across all open boards). apiKey comes from the
  // dialog/config; the token comes from the dialog or the stored credential.
  async listTrelloLists(
    formId: string,
    input: { apiKey: string; credential?: string },
    ctx: Ctx,
  ): Promise<TrelloListOption[]> {
    await this.assertForm(formId, ctx);

    const apiKey = input.apiKey?.trim();

    if (!apiKey)
      throw new BadRequestException(
        'A Trello API key is required to list Lists',
      );

    const token =
      input.credential?.trim() ||
      (await this.loadTrelloCredential(formId, ctx));

    if (!token)
      throw new BadRequestException('A Trello token is required to list Lists');

    try {
      return await listTrelloLists(apiKey, token);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load Trello lists',
      );
    }
  }

  // Lists all Airtable bases the PAT can read, for the base picker.
  async listAirtableBases(
    formId: string,
    credential: string | undefined,
    ctx: Ctx,
  ): Promise<AirtableBaseOption[]> {
    await this.assertForm(formId, ctx);

    const token =
      credential?.trim() || (await this.loadAirtableCredential(formId, ctx));

    if (!token)
      throw new BadRequestException(
        'An Airtable Personal Access Token is required to list bases',
      );

    try {
      return await listAirtableBases(token);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load Airtable bases',
      );
    }
  }

  // Lists all tables in a given Airtable base, for the cascading table picker.
  async listAirtableTables(
    formId: string,
    input: { baseId: string; credential?: string },
    ctx: Ctx,
  ): Promise<AirtableTableOption[]> {
    await this.assertForm(formId, ctx);

    const baseId = input.baseId?.trim();

    if (!baseId)
      throw new BadRequestException(
        'baseId is required to list Airtable tables',
      );

    const token =
      input.credential?.trim() ||
      (await this.loadAirtableCredential(formId, ctx));

    if (!token)
      throw new BadRequestException(
        'An Airtable Personal Access Token is required to list tables',
      );

    try {
      return await listAirtableTables(token, baseId);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load Airtable tables',
      );
    }
  }

  // Lists the connected Jira account's projects for the project-key picker.
  async listJiraProjects(
    formId: string,
    input: { siteUrl: string; email: string; credential?: string },
    ctx: Ctx,
  ): Promise<JiraProjectOption[]> {
    await this.assertForm(formId, ctx);

    const siteUrl = input.siteUrl?.trim();
    const email = input.email?.trim();

    if (!siteUrl || !email)
      throw new BadRequestException(
        'A Jira site URL and account email are required to list projects',
      );

    const token =
      input.credential?.trim() ||
      (await this.loadProviderCredential(formId, 'jira', ctx));

    if (!token)
      throw new BadRequestException(
        'A Jira API token is required to list projects',
      );

    try {
      return await listJiraProjects(siteUrl, email, token);
    } catch (err) {
      throw new BadRequestException(
        describeFetchFailure(err) ?? 'Could not load Jira projects',
      );
    }
  }

  // Lists the creatable issue types in one Jira project, for the cascading picker.
  async listJiraIssueTypes(
    formId: string,
    input: {
      siteUrl: string;
      email: string;
      projectKey: string;
      credential?: string;
    },
    ctx: Ctx,
  ): Promise<JiraIssueTypeOption[]> {
    await this.assertForm(formId, ctx);

    const siteUrl = input.siteUrl?.trim();
    const email = input.email?.trim();
    const projectKey = input.projectKey?.trim();

    if (!siteUrl || !email || !projectKey)
      throw new BadRequestException(
        'A Jira site URL, account email and project key are required to list issue types',
      );

    const token =
      input.credential?.trim() ||
      (await this.loadProviderCredential(formId, 'jira', ctx));

    if (!token)
      throw new BadRequestException(
        'A Jira API token is required to list issue types',
      );

    try {
      return await listJiraIssueTypes(siteUrl, email, token, projectKey);
    } catch (err) {
      throw new BadRequestException(
        describeFetchFailure(err) ?? 'Could not load Jira issue types',
      );
    }
  }

  // Lists writable HubSpot contact properties for the field-mapping dropdowns.
  async listHubspotProperties(
    formId: string,
    credential: string | undefined,
    ctx: Ctx,
  ): Promise<CrmFieldOption[]> {
    await this.assertForm(formId, ctx);

    const token =
      credential?.trim() ||
      (await this.loadProviderCredential(formId, 'hubspot', ctx));

    if (!token)
      throw new BadRequestException(
        'A HubSpot Private App token is required to list contact properties',
      );

    try {
      return await listHubspotProperties(token);
    } catch (err) {
      throw new BadRequestException(
        describeFetchFailure(err) ?? 'Could not load HubSpot properties',
      );
    }
  }

  // Lists createable Salesforce Lead fields for the field-mapping dropdowns.
  // The Connected App key/secret live in server env, so no credential is taken from the client.
  async listSalesforceLeadFields(
    formId: string,
    input: { instanceUrl: string },
    ctx: Ctx,
  ): Promise<CrmFieldOption[]> {
    await this.assertForm(formId, ctx);

    const instanceUrl = input.instanceUrl?.trim();

    if (!instanceUrl)
      throw new BadRequestException(
        'A Salesforce instance URL is required to list Lead fields',
      );

    try {
      return await listSalesforceLeadFields(instanceUrl);
    } catch (err) {
      // Log the whole error server-side: the client only ever sees a flattened string, so the
      // stack + nested `cause` chain is otherwise lost when a transport failure happens.
      this.logger.error(
        `Salesforce Lead-field lookup failed for ${instanceUrl}`,
        err as Error,
      );

      throw new BadRequestException(
        describeFetchFailure(err) ?? 'Could not load Salesforce Lead fields',
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async loadGithubCredential(
    formId: string,
    ctx: Ctx,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .select('secret_encrypted, secret_iv, secret_tag')
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('provider', 'github')
      .not('secret_encrypted', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const row = data as {
      secret_encrypted?: string | null;
      secret_iv?: string | null;
      secret_tag?: string | null;
    } | null;

    if (!row?.secret_encrypted || !row.secret_iv || !row.secret_tag)
      return null;

    try {
      return decryptApiKey(row.secret_encrypted, row.secret_iv, row.secret_tag);
    } catch {
      return null;
    }
  }

  // Returns the decrypted credential of this form's stored integration for `provider`, or null when
  // none is stored. Lets the pickers work in edit mode with a blank credential field.
  private async loadProviderCredential(
    formId: string,
    provider: string,
    ctx: Ctx,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .select('secret_encrypted, secret_iv, secret_tag')
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('provider', provider)
      .not('secret_encrypted', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const row = data as {
      secret_encrypted?: string | null;
      secret_iv?: string | null;
      secret_tag?: string | null;
    } | null;

    if (!row?.secret_encrypted || !row.secret_iv || !row.secret_tag)
      return null;

    try {
      return decryptApiKey(row.secret_encrypted, row.secret_iv, row.secret_tag);
    } catch {
      return null;
    }
  }

  private loadClickupCredential(formId: string, ctx: Ctx) {
    return this.loadProviderCredential(formId, 'clickup', ctx);
  }

  private loadTrelloCredential(formId: string, ctx: Ctx) {
    return this.loadProviderCredential(formId, 'trello', ctx);
  }

  private loadAirtableCredential(formId: string, ctx: Ctx) {
    return this.loadProviderCredential(formId, 'airtable', ctx);
  }

  private async assertForm(formId: string, ctx: Ctx): Promise<void> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('id')
      .eq('id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('is_deleted', false)
      .maybeSingle();

    // Name the layer: supabase-js reports a transport failure as the bare string "fetch failed",
    // which is indistinguishable from a provider-side failure once it reaches the client.
    if (error)
      throw new BadRequestException(`Database lookup failed: ${error.message}`);
    if (!data) throw new NotFoundException('Form not found');
  }

  private async getOr404(
    formId: string,
    integrationId: string,
    ctx: Ctx,
  ): Promise<IntegrationRow> {
    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .select(
        'id, provider, config, field_map, is_active, secret_encrypted, secret_iv, secret_tag',
      )
      .eq('id', integrationId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Integration not found');

    return data as IntegrationRow;
  }

  private encryptCredential(credential: string): {
    secret_encrypted: string;
    secret_iv: string;
    secret_tag: string;
  } {
    const { encrypted, iv, tag } = encryptApiKey(credential);

    return { secret_encrypted: encrypted, secret_iv: iv, secret_tag: tag };
  }

  private toView(row: Record<string, unknown>): IntegrationView {
    return {
      id: row.id as string,
      form_id: row.form_id as string,
      provider: row.provider as string,
      config: (row.config as Record<string, unknown>) ?? {},
      field_map: (row.field_map as unknown[]) ?? [],
      is_active: row.is_active as boolean,
      hasCredential: Boolean(row.secret_encrypted),
      created_by: (row.created_by as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
