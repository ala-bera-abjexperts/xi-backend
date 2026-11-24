/**
 * @fileoverview Where a restore is allowed to write, and the client it writes through.
 * @module src/backup/services/restore-destinations.service
 *
 * A restore used to write into the database and the organization it was started from, so there was
 * nothing to choose. This makes the destination an explicit decision taken BEFORE the run.
 *
 * ## The rule this service exists to hold
 *
 * A restore preserves primary keys, and every foreign key in this schema is single-column and
 * id-only — `tasks_space_id_fkey` references `spaces(id)`, with no organization component. Verified
 * against the live catalog.
 *
 * Together those make a same-database restore into a DIFFERENT organization unsafe, and unsafe
 * silently: org A's tasks restored into org B keep org A's `space_id`, the foreign key RESOLVES
 * because org A's space is still there, and org B ends up holding rows that point into org A. No
 * constraint objects and no conflict is recorded. Restoring the spaces too does not help — their ids
 * collide with the rows org A still owns, so they are skipped as duplicates and the tasks point at
 * org A regardless.
 *
 * A different Supabase instance holds none of those ids, so preserved keys are safe there. Hence:
 * another organization requires another instance. The database enforces it with a CHECK; this
 * service refuses it early so the operator gets a sentence rather than a constraint violation.
 *
 * ## What is not stored
 *
 * The archive passphrase. It belongs to the archive, not the destination, and is still supplied per
 * request. Only the destination's own service-role key is sealed here.
 */

import { createClient } from '@supabase/supabase-js';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { BackupSecretsService } from './backup-secrets.service';

const TABLE = 'restore_destinations';

/** How long a connection test may hang before it is called unreachable. */
const TEST_TIMEOUT_MS = 10_000;

/** Ceiling on the organization picker. Past this a dropdown is the wrong control anyway. */
const MAX_REMOTE_ORGANIZATIONS = 500;

export interface DestinationRow {
  id: string;
  organization_id: string;
  name: string;
  kind: 'this_instance' | 'supabase';
  supabase_url: string | null;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
  target_organization_id: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_detail: string | null;
  created_at: string;
}

/** A destination as the API returns it. The sealed key never leaves this service. */
export interface DestinationView {
  id: string;
  name: string;
  kind: 'this_instance' | 'supabase';
  supabase_url: string | null;
  target_organization_id: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_detail: string | null;
  created_at: string;
}

export interface CreateDestinationInput {
  name: string;
  kind: 'this_instance' | 'supabase';
  supabaseUrl?: string;
  serviceKey?: string;
  targetOrganizationId?: string;
}

/**
 * A client shaped like the one `SupabaseAdminService` hands out.
 *
 * Taken from that method rather than written as `SupabaseClient`: the bare generic defaults differ
 * from the schema-parameterised form the admin service returns, so the two are not assignable and
 * the mismatch surfaces as an unsafe-assignment error at every call site.
 */
export type RestoreClient = ReturnType<SupabaseAdminService['getClient']>;

/** The client a restore writes through, and the tenant it writes into. */
export interface ResolvedDestination {
  client: RestoreClient;
  organizationId: string;
  /** False when writing to another Supabase, which the run records and the UI says out loud. */
  isThisInstance: boolean;
  name: string;
}

@Injectable()
export class RestoreDestinationsService {
  private readonly logger = new Logger(RestoreDestinationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly secrets: BackupSecretsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Destinations this organization has configured, newest first. */
  async list(organizationId: string): Promise<DestinationView[]> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })) as unknown as {
      data: DestinationRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Failed to list restore destinations: ${error.message}`,
      );
    }

    return (data ?? []).map((row) => this.toView(row));
  }

  /**
   * Adds a destination.
   *
   * @throws BadRequestException when another organization is named without another instance — the
   *   combination that would link two tenants. Refused here as well as by the database CHECK,
   *   because a sentence is more use than a constraint name.
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateDestinationInput,
  ): Promise<DestinationView> {
    const targetOrganizationId = input.targetOrganizationId ?? null;
    const crossOrg =
      targetOrganizationId !== null && targetOrganizationId !== organizationId;

    if (crossOrg && input.kind !== 'supabase') {
      throw new BadRequestException(
        'Restoring into a different organization needs a different Supabase instance. On this ' +
          'one the archived ids already belong to the organization the backup came from, so the ' +
          'restored rows would point back at it.',
      );
    }

    if (
      input.kind === 'supabase' &&
      (!input.supabaseUrl || !input.serviceKey)
    ) {
      throw new BadRequestException(
        'A Supabase destination needs both its URL and a service-role key.',
      );
    }

    if (input.supabaseUrl) {
      this.assertUrl(input.supabaseUrl);
    }

    const sealed = input.serviceKey
      ? this.secrets.sealServiceKey(input.serviceKey)
      : {};

    const { data, error } = (await this.db
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        name: input.name,
        kind: input.kind,
        supabase_url: input.supabaseUrl ?? null,
        target_organization_id: targetOrganizationId,
        created_by: userId,
        ...sealed,
      })
      .select('*')
      .single()) as unknown as {
      data: DestinationRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error || !data) {
      if (error?.code === '23505') {
        throw new BadRequestException(
          `A destination called "${input.name}" already exists.`,
        );
      }

      throw new BadRequestException(
        `Could not save this destination: ${error?.message ?? 'no row returned'}`,
      );
    }

    return this.toView(data);
  }

  /**
   * Proves a destination is reachable, and records the answer.
   *
   * Run before a restore rather than during one: discovering a bad URL after the operator has
   * confirmed an irreversible write is the worst possible moment to find out.
   */
  async test(
    organizationId: string,
    id: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const row = await this.getRow(organizationId, id);
    const outcome = await this.probe(row);

    await this.db
      .from(TABLE)
      .update({
        last_tested_at: new Date().toISOString(),
        last_test_ok: outcome.ok,
        last_test_detail: outcome.detail,
      })
      .eq('id', id)
      .eq('organization_id', organizationId);

    return outcome;
  }

  /**
   * The organizations that exist ON THE DESTINATION.
   *
   * The picker cannot be filled from this instance's tenant list. A destination is a different
   * Supabase project with its own `organizations` table and its own UUIDs, so an id chosen here
   * means nothing there — at best the restore fails a foreign key, at worst the id happens to
   * exist and one tenant's rows land inside another's.
   *
   * Read with the service key the operator just entered, before the destination is saved, because
   * the choice has to be made while the form is still open. The key is used for this request and
   * kept nowhere.
   */
  async listRemoteOrganizations(
    supabaseUrl: string,
    serviceKey: string,
  ): Promise<{ id: string; name: string; slug: string | null }[]> {
    // Same rule the stored destinations are held to. An http URL would put a service-role key on
    // the wire in the clear.
    if (!supabaseUrl.startsWith('https://')) {
      throw new BadRequestException('The destination URL must be https.');
    }

    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RestoreClient;

    const query = client
      .from('organizations')
      .select('id, name, slug')
      .order('name', { ascending: true })
      // Bounded: an instance with thousands of tenants must not turn one picker into a huge
      // response. A destination with more than this is not something to choose from a dropdown.
      .limit(MAX_REMOTE_ORGANIZATIONS);

    // Bounded for the same reason `probe` is: the address is chosen by the caller, so an
    // unreachable host must not hold a request open.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`No answer within ${TEST_TIMEOUT_MS} ms`)),
        TEST_TIMEOUT_MS,
      ).unref(),
    );

    let result: {
      data: { id: string; name: string; slug: string | null }[] | null;
      error: { message: string } | null;
    };

    try {
      result = (await Promise.race([query, timeout])) as typeof result;
    } catch (err) {
      throw new BadRequestException(
        `Could not reach that instance: ${(err as Error).message}`,
      );
    }

    if (result.error) {
      // The most common causes are a wrong key and a URL pointing at something that is not this
      // product. Both are the operator's to fix, so the reason is passed through rather than
      // flattened into "failed".
      throw new BadRequestException(
        `Could not read organizations from that instance: ${result.error.message}`,
      );
    }

    return result.data ?? [];
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      throw new BadRequestException(
        `Could not remove this destination: ${error.message}`,
      );
    }
  }

  /**
   * The client a restore should write through.
   *
   * @param id Null for the default: this instance, this organization — which is what every restore
   *   did before destinations existed, so an absent destination stays correct.
   */
  async resolve(
    organizationId: string,
    id: string | null,
  ): Promise<ResolvedDestination> {
    if (!id) {
      return {
        client: this.db,
        organizationId,
        isThisInstance: true,
        name: 'This instance',
      };
    }

    const row = await this.getRow(organizationId, id);

    // Re-checked at use, not only at creation. A row edited directly in the database, or one
    // written before the CHECK existed, must not become a way past the rule.
    const target = row.target_organization_id ?? organizationId;

    if (target !== organizationId && row.kind !== 'supabase') {
      throw new BadRequestException(
        'This destination writes into a different organization on this instance, which is not ' +
          'safe. Point it at a different Supabase instance instead.',
      );
    }

    if (row.kind === 'this_instance') {
      return {
        client: this.db,
        organizationId: target,
        isThisInstance: true,
        name: row.name,
      };
    }

    return {
      client: this.openClient(row),
      organizationId: target,
      isThisInstance: false,
      name: row.name,
    };
  }

  /** Opens a second service-role client against another Supabase. */
  private openClient(row: DestinationRow): RestoreClient {
    if (!row.supabase_url) {
      throw new BadRequestException(
        `Destination "${row.name}" has no Supabase URL.`,
      );
    }

    // Cast for the same generic-defaults reason as `RestoreClient` above: createClient's untyped
    // form and the admin service's schema-parameterised one describe the same object.
    return createClient(row.supabase_url, this.secrets.openServiceKey(row), {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RestoreClient;
  }

  /** One cheap read against the destination, bounded so an unreachable host cannot hang a request. */
  private async probe(
    row: DestinationRow,
  ): Promise<{ ok: boolean; detail: string }> {
    if (row.kind === 'this_instance') {
      return { ok: true, detail: 'This instance is always reachable.' };
    }

    try {
      const client = this.openClient(row);

      const query = client
        .from('organizations')
        .select('id', { count: 'exact', head: true })
        .limit(1);

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`No answer within ${TEST_TIMEOUT_MS} ms`)),
          TEST_TIMEOUT_MS,
        ).unref(),
      );

      const { error } = (await Promise.race([query, timeout])) as {
        error: { message: string } | null;
      };

      if (error) {
        return { ok: false, detail: error.message };
      }

      return { ok: true, detail: 'Connected, and the schema looks right.' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * Refuses a URL that is not an https origin.
   *
   * The service-role key is sent to whatever this names, so a typo pointing at someone else's host
   * hands them the key. http is refused outright rather than warned about.
   */
  private assertUrl(url: string): void {
    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException(
        `"${url}" is not a valid URL. It should look like https://your-project.supabase.co`,
      );
    }

    if (parsed.protocol !== 'https:') {
      throw new BadRequestException(
        'A Supabase destination must use https — its service-role key is sent to this address.',
      );
    }
  }

  private async getRow(
    organizationId: string,
    id: string,
  ): Promise<DestinationRow> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: DestinationRow | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new NotFoundException('Restore destination not found');
    }

    return data;
  }

  /**
   * Spaces belonging to one organization, for the restore wizard's space picker.
   *
   * This exists because `GET /spaces` resolves the organization from the session and ignores the
   * query parameter, so asking it for another tenant's spaces silently returns your own — the
   * picker would name a space that is not in the organization the operator chose.
   *
   * Membership is checked against `organization_members` rather than taken from the parameter. The
   * caller may only ever list spaces of an organization they actually belong to, which is what
   * keeps this from becoming a way to enumerate another tenant.
   */
  async listSpaces(
    callerUserId: string,
    organizationId: string,
  ): Promise<{ id: string; name: string; key: string | null }[]> {
    const { data: membership } = (await this.db
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', callerUserId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: { organization_id: string } | null;
    };

    if (!membership) {
      throw new NotFoundException(
        'That organization is not one you belong to, so its spaces cannot be listed.',
      );
    }

    const { data, error } = (await this.db
      .from('spaces')
      .select('id, name, key')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true })) as unknown as {
      data: { id: string; name: string; key: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Could not list that organization's spaces: ${error.message}`,
      );
    }

    return data ?? [];
  }

  /** Strips the sealed key. A destination row is never returned whole. */
  private toView(row: DestinationRow): DestinationView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      supabase_url: row.supabase_url,
      target_organization_id: row.target_organization_id,
      last_tested_at: row.last_tested_at,
      last_test_ok: row.last_test_ok,
      last_test_detail: row.last_test_detail,
      created_at: row.created_at,
    };
  }
}
