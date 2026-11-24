/**
 * @fileoverview A person's linked GitHub / GitLab account (ticket 2): link through the provider's
 * sign-in, unlink, the admin's list of linked members, and the resolver that turns a Git author
 * into the XISUITE person shown on tasks.
 *
 * Only WHO the person is gets stored (immutable account id, username, avatar, profile URL). The
 * user token is used once for `GET /user` and then revoked; it is never stored.
 *
 * A link belongs to the person (no organization_id). Whether it is shown in an organization is
 * decided when reading: the person must currently be a member there. So unlinking or leaving an
 * organization needs no data change, and linking is retroactive for earlier pull requests.
 * @module src/git-integrations/git-identities.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { createState } from '../calendar/integrations/calendar-oauth.state';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  AZURE_IDENTITY_SCOPE,
  AzureDevopsClient,
} from './azure-devops/azure-devops.client';
import {
  GithubAppClient,
  githubAuthorizeUrl,
} from './github/github-app.client';
import { GitlabClient } from './gitlab/gitlab.client';
import { GitServersService } from './git-servers.service';
import type { GitProvider, IGitActor, IGitApp } from './git-integrations.types';
import {
  assertStateSecret,
  identityReturnUrl,
  identityStateTag,
  pkceVerifier,
  type GitIdentityReturnPage,
} from './git-integrations.util';

const IDENTITIES = 'git_user_identities';
const UNIQUE_VIOLATION = '23505';
const ID_CHUNK = 100;
const MEMBER_PAGE = 1000;

export interface IGitIdentityRow {
  id: string;
  user_id: string;
  provider: GitProvider;
  host: string;
  external_user_id: string;
  login: string;
  avatar_url: string | null;
  profile_url: string | null;
  linked_at: string;
}

/** The provider account behind a sign-in. */
export interface IGitAccountIdentity {
  externalUserId: string;
  login: string;
  avatarUrl: string | null;
  profileUrl: string | null;
}

export interface IMyGitIdentityDto {
  provider: GitProvider;
  configured: boolean;
  /** Ticket 11: null for the built-in app, else the organization's own server. */
  serverId: string | null;
  serverName: string | null;
  /** The identity host key (github.com, gitlab.com, or the server's host). */
  host: string;
  identity: {
    login: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    linkedAt: string;
  } | null;
}

export interface ILinkedMemberDto {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  login: string;
  profileUrl: string | null;
  linkedAt: string;
}

/** A Git author as the provider reports it on a pull request, commit or build. */
export interface IGitAuthor {
  externalId: string;
  login: string;
  /** GitHub `type` ('User', 'Bot', ...) when known. */
  type?: string | null;
}

export interface IResolvedAuthor {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

/** Dependabot, Renovate, GitHub Actions... never a person, never linkable. */
export function isBotAuthor(
  author: Pick<IGitAuthor, 'login' | 'type'>,
): boolean {
  return (
    (author.type != null && author.type !== 'User') ||
    /\[bot\]$/i.test(author.login)
  );
}

/** Linking needs only the OAuth client of the App / application. */
function hasOAuthClient(app: IGitApp): boolean {
  return !!(app.clientId && app.clientSecret);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));

  return out;
}

export function displayName(
  user: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  },
  fallback: string,
): string {
  return (
    `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() ||
    user.email ||
    fallback
  );
}

@Injectable()
export class GitIdentitiesService {
  private readonly logger = new Logger(GitIdentitiesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly audit: AuditLogsService,
    private readonly github: GithubAppClient,
    private readonly gitlab: GitlabClient,
    private readonly servers: GitServersService,
    private readonly azureDevops: AzureDevopsClient,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // Provider plumbing
  // ---------------------------------------------------------------------------

  /** Linking needs only the OAuth client of the App / application, not the App key. */
  isConfigured(provider: GitProvider): boolean {
    return hasOAuthClient(this.servers.builtinApp(provider));
  }

  /** The host key of the built-in app (github.com, gitlab.com or the GITLAB_BASE_URL host). */
  hostOf(provider: GitProvider): string {
    return this.servers.builtinHost(provider);
  }

  /** The host of the organization's server `serverId`, or the built-in host when none is given. */
  private async hostFor(
    organizationId: string,
    provider: GitProvider,
    serverId?: string | null,
  ): Promise<string> {
    if (!serverId) return this.hostOf(provider);

    const server = await this.servers.get(organizationId, serverId);

    if (server.provider !== provider)
      throw new BadRequestException('server_mismatch');

    return server.host;
  }

  private redirectUri(provider: GitProvider): string {
    return `${this.servers.publicApiUrl}/git-integrations/${provider}/callback`;
  }

  /**
   * The provider sign-in address for linking the signed-in person's own account, on the built-in app or
   * on the organization's server `serverId` (ticket 11).
   */
  async connectUrl(
    provider: GitProvider,
    userId: string,
    organizationId: string,
    returnTo: string | undefined,
    page: GitIdentityReturnPage,
    serverId?: string | null,
  ): Promise<string> {
    assertStateSecret();

    const app = await this.servers.appForStart(
      organizationId,
      provider,
      serverId,
    );

    if (!hasOAuthClient(app)) throw new BadRequestException('not_configured');

    const state = createState(
      userId,
      organizationId,
      identityStateTag(provider, page, app.serverId),
      returnTo,
    );

    if (provider === 'azure_devops')
      return this.azureDevops.authorizeUrl(app, {
        redirectUri: this.redirectUri('azure_devops'),
        scope: AZURE_IDENTITY_SCOPE,
        state,
        codeVerifier: pkceVerifier(state),
      });

    if (provider === 'github') {
      const query = new URLSearchParams({
        client_id: app.clientId ?? '',
        redirect_uri: this.redirectUri('github'),
        state,
      });

      return `${githubAuthorizeUrl(app)}?${query.toString()}`;
    }

    const query = new URLSearchParams({
      client_id: app.clientId ?? '',
      redirect_uri: this.redirectUri('gitlab'),
      response_type: 'code',
      // Who the person is, nothing else: no repository or API access.
      scope: 'read_user',
      state,
    });

    return `${app.webUrl}/oauth/authorize?${query.toString()}`;
  }

  /** Exchanges the code, reads who signed in and revokes the token straight away. */
  private async readAccount(
    app: IGitApp,
    code: string,
    state: string | undefined,
  ): Promise<IGitAccountIdentity> {
    if (app.provider === 'azure_devops') {
      if (!state) throw new BadRequestException('expired');

      // Entra has no token revocation for an app; this token is simply never stored.
      const tokens = await this.azureDevops.exchangeCode(app, {
        code,
        redirectUri: this.redirectUri('azure_devops'),
        scope: AZURE_IDENTITY_SCOPE,
        codeVerifier: pkceVerifier(state),
      });
      const profile = await this.azureDevops.profile(tokens.accessToken);
      const login = (
        profile.emailAddress ??
        profile.publicAlias ??
        profile.id
      ).toLowerCase();

      return {
        externalUserId: profile.id,
        login,
        avatarUrl: null,
        profileUrl: null,
      };
    }

    if (app.provider === 'github') {
      const token = await this.github.exchangeCode(
        app,
        code,
        this.redirectUri('github'),
      );

      try {
        const user = await this.github.getUser(app, token);

        if (user.type && user.type !== 'User')
          throw new BadRequestException('bot_account');

        return {
          externalUserId: String(user.id),
          login: user.login,
          avatarUrl: user.avatar_url ?? null,
          profileUrl: user.html_url ?? null,
        };
      } finally {
        void this.github.revokeUserToken(app, token);
      }
    }

    const tokens = await this.gitlab.exchangeCode(
      app,
      code,
      this.redirectUri('gitlab'),
    );

    try {
      const user = await this.gitlab.api<{
        id: number;
        username: string;
        avatar_url?: string | null;
        web_url?: string | null;
        bot?: boolean;
      }>(app, '/user', tokens.accessToken);

      if (user.bot) throw new BadRequestException('bot_account');

      return {
        externalUserId: String(user.id),
        login: user.username,
        avatarUrl: user.avatar_url ?? null,
        profileUrl: user.web_url ?? null,
      };
    } finally {
      void this.gitlab.revoke(app, tokens.accessToken);
    }
  }

  /**
   * The provider sent the person back. Never throws: every outcome is a redirect to the page the
   * flow started from, with `connected=<provider>` or `error=<code>`.
   */
  async handleCallback(input: {
    provider: GitProvider;
    page: GitIdentityReturnPage;
    userId: string;
    organizationId: string;
    returnTo?: string;
    code?: string;
    error?: string;
    /** The signed state as sent: the PKCE verifier of an Azure DevOps sign-in derives from it. */
    state?: string;
    /** Ticket 11: the organization's own server the link was started on (from the signed state). */
    serverId?: string;
  }): Promise<string> {
    const back = (params: Record<string, string>) =>
      identityReturnUrl(input.returnTo, input.provider, input.page, {
        ...params,
        ...(input.serverId && { server: input.serverId }),
      });

    if (input.error) return back({ error: input.error.slice(0, 50) });
    if (!input.code) return back({ error: 'expired' });

    try {
      if (!(await this.isMember(input.organizationId, input.userId)))
        return back({ error: 'forbidden' });

      const app = await this.servers.appForStart(
        input.organizationId,
        input.provider,
        input.serverId,
      );
      const account = await this.readAccount(app, input.code, input.state);

      await this.link(
        input.userId,
        input.organizationId,
        input.provider,
        account,
        app.host,
      );

      return back({ connected: input.provider });
    } catch (error) {
      if (error instanceof ConflictException)
        return back({ error: 'identity_taken' });
      if (error instanceof BadRequestException) {
        const code = (error.getResponse() as { message?: unknown }).message;

        return back({ error: typeof code === 'string' ? code : 'failed' });
      }

      this.logger.warn(
        `identity callback ${input.provider}: ${error instanceof Error ? error.message : error}`,
      );

      return back({ error: 'exchange_failed' });
    }
  }

  // ---------------------------------------------------------------------------
  // Link / unlink
  // ---------------------------------------------------------------------------

  /**
   * Links `account` to the user, replacing their previous account of this provider. A Git account
   * already linked to someone else is a 409: one Git account belongs to exactly one person.
   */
  async link(
    userId: string,
    organizationId: string,
    provider: GitProvider,
    account: IGitAccountIdentity,
    host: string = this.hostOf(provider),
  ): Promise<IGitIdentityRow> {
    const { data: owner, error: ownerError } = await this.db
      .from(IDENTITIES)
      .select('id, user_id')
      .eq('provider', provider)
      .eq('host', host)
      .eq('external_user_id', account.externalUserId)
      .maybeSingle();

    if (ownerError) throw new InternalServerErrorException(ownerError.message);
    if (owner && (owner as { user_id: string }).user_id !== userId) {
      throw new ConflictException({
        code: 'identity_taken',
        message: `${account.login} is linked to another user`,
      });
    }

    const { data: mine, error: mineError } = await this.db
      .from(IDENTITIES)
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('host', host)
      .maybeSingle();

    if (mineError) throw new InternalServerErrorException(mineError.message);

    const previous = mine as IGitIdentityRow | null;
    const fields = {
      external_user_id: account.externalUserId,
      login: account.login,
      avatar_url: account.avatarUrl,
      profile_url: account.profileUrl,
    };

    const write = previous
      ? this.db
          .from(IDENTITIES)
          .update({
            ...fields,
            ...(previous.external_user_id !== account.externalUserId && {
              linked_at: new Date().toISOString(),
            }),
          })
          .eq('id', previous.id)
          .eq('user_id', userId)
      : this.db
          .from(IDENTITIES)
          .insert({ ...fields, user_id: userId, provider, host });

    const { data, error } = await write.select('*').single();

    if (error) {
      // Someone else linked the same Git account at the same moment.
      if (error.code === UNIQUE_VIOLATION) {
        throw new ConflictException({
          code: 'identity_taken',
          message: `${account.login} is linked to another user`,
        });
      }

      throw new InternalServerErrorException(error.message);
    }

    const sameAccount = previous?.external_user_id === account.externalUserId;

    if (!sameAccount) {
      void this.audit.logAction(
        organizationId,
        userId,
        'git_user_identity',
        (data as IGitIdentityRow).id,
        'create',
        {
          event: previous ? 'relink' : 'link',
          provider,
          host,
          login: account.login,
          ...(previous && { previous_login: previous.login }),
        },
      );
    }

    return data as IGitIdentityRow;
  }

  /** The signed-in person removes their own link. */
  async unlink(
    userId: string,
    organizationId: string,
    provider: GitProvider,
    serverId?: string | null,
  ): Promise<void> {
    const host = await this.hostFor(organizationId, provider, serverId);
    const { data, error } = await this.db
      .from(IDENTITIES)
      .delete()
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('host', host)
      .select('id, login');

    if (error) throw new InternalServerErrorException(error.message);

    for (const row of (data ?? []) as { id: string; login: string }[]) {
      void this.audit.logAction(
        organizationId,
        userId,
        'git_user_identity',
        row.id,
        'delete',
        {
          event: 'unlink',
          provider,
          host,
          login: row.login,
        },
      );
    }
  }

  /**
   * One entry per place the person can link an account: the built-in app of each provider (always, with
   * its configured flag) plus, when `organizationId` is given, each own server of that organization
   * (ticket 11).
   */
  async listMine(
    userId: string,
    organizationId?: string,
  ): Promise<IMyGitIdentityDto[]> {
    const { data, error } = await this.db
      .from(IDENTITIES)
      .select('*')
      .eq('user_id', userId);

    if (error) throw new InternalServerErrorException(error.message);

    const rows = (data ?? []) as IGitIdentityRow[];
    const targets: Omit<IMyGitIdentityDto, 'identity'>[] = (
      ['github', 'gitlab', 'azure_devops'] as GitProvider[]
    ).map((provider) => ({
      provider,
      configured: this.isConfigured(provider),
      serverId: null,
      serverName: null,
      host: this.hostOf(provider),
    }));

    if (organizationId) {
      for (const server of await this.servers.list(organizationId)) {
        // An own app on the built-in host (on-premise) replaces the unconfigured built-in entry.
        const index = targets.findIndex(
          (target) =>
            !target.serverId &&
            target.provider === server.provider &&
            target.host === server.host,
        );
        const entry = {
          provider: server.provider,
          configured: hasOAuthClient(this.servers.toApp(server)),
          serverId: server.id,
          serverName: server.name,
          host: server.host,
        };

        if (index >= 0) targets[index] = entry;
        else targets.push(entry);
      }
    }

    return targets.map((target) => {
      const row = rows.find(
        (item) =>
          item.provider === target.provider && item.host === target.host,
      );

      return {
        ...target,
        identity: row
          ? {
              login: row.login,
              avatarUrl: row.avatar_url,
              profileUrl: row.profile_url,
              linkedAt: row.linked_at,
            }
          : null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: linked members of one organization
  // ---------------------------------------------------------------------------

  private async memberIds(
    organizationId: string,
    userIds?: string[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();

    if (userIds && !userIds.length) return ids;

    if (userIds) {
      for (const batch of chunk(userIds, ID_CHUNK)) {
        const { data, error } = await this.db
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .in('user_id', batch);

        if (error) throw new InternalServerErrorException(error.message);

        for (const row of (data ?? []) as { user_id: string }[])
          ids.add(row.user_id);
      }

      return ids;
    }

    // Every member: paged, because PostgREST caps one response at max_rows (1000 by default).
    for (let from = 0; ; from += MEMBER_PAGE) {
      const { data, error } = await this.db
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .order('user_id', { ascending: true })
        .range(from, from + MEMBER_PAGE - 1);

      if (error) throw new InternalServerErrorException(error.message);

      const rows = (data ?? []) as { user_id: string }[];

      for (const row of rows) ids.add(row.user_id);

      if (rows.length < MEMBER_PAGE) return ids;
    }
  }

  private async isMember(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    return (await this.memberIds(organizationId, [userId])).has(userId);
  }

  private async usersById(userIds: string[]) {
    const users = new Map<
      string,
      {
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        avatar_url: string | null;
      }
    >();

    for (const batch of chunk(userIds, ID_CHUNK)) {
      const { data, error } = await this.db
        .from('users')
        .select('id, first_name, last_name, email, avatar_url')
        .in('id', batch);

      if (error) throw new InternalServerErrorException(error.message);

      for (const user of (data ?? []) as {
        id: string;
        first_name: string | null;
        last_name: string | null;
        email: string | null;
        avatar_url: string | null;
      }[]) {
        users.set(user.id, user);
      }
    }

    return users;
  }

  /** Members of this organization who linked an account of this provider. */
  async listLinkedMembers(
    organizationId: string,
    provider: GitProvider,
    serverId?: string | null,
  ): Promise<ILinkedMemberDto[]> {
    const host = await this.hostFor(organizationId, provider, serverId);
    const members = [...(await this.memberIds(organizationId))];
    const rows: IGitIdentityRow[] = [];

    for (const batch of chunk(members, ID_CHUNK)) {
      const { data, error } = await this.db
        .from(IDENTITIES)
        .select('*')
        .eq('provider', provider)
        .eq('host', host)
        .in('user_id', batch);

      if (error) throw new InternalServerErrorException(error.message);

      rows.push(...((data ?? []) as IGitIdentityRow[]));
    }

    const users = await this.usersById(rows.map((row) => row.user_id));

    return rows
      .map((row) => {
        const user = users.get(row.user_id);

        return {
          userId: row.user_id,
          name: user ? displayName(user, row.login) : row.login,
          email: user?.email ?? null,
          avatarUrl: user?.avatar_url ?? null,
          login: row.login,
          profileUrl: row.profile_url,
          linkedAt: row.linked_at,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** An admin removes a wrong link of a member of THEIR organization. */
  async removeMemberLink(
    organizationId: string,
    adminUserId: string,
    provider: GitProvider,
    targetUserId: string,
    serverId?: string | null,
  ): Promise<void> {
    const host = await this.hostFor(organizationId, provider, serverId);

    if (!(await this.isMember(organizationId, targetUserId)))
      throw new NotFoundException('Member not found');

    const { data, error } = await this.db
      .from(IDENTITIES)
      .delete()
      .eq('user_id', targetUserId)
      .eq('provider', provider)
      .eq('host', host)
      .select('id, login');

    if (error) throw new InternalServerErrorException(error.message);

    const removed = (data ?? []) as { id: string; login: string }[];

    if (!removed.length) throw new NotFoundException('No linked account');

    for (const row of removed) {
      void this.audit.logAction(
        organizationId,
        adminUserId,
        'git_user_identity',
        row.id,
        'delete',
        {
          event: 'admin_remove',
          provider,
          host,
          login: row.login,
          target_user_id: targetUserId,
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Resolver (tickets 4-7 render authors through this)
  // ---------------------------------------------------------------------------

  /**
   * The XISUITE person behind each Git author, for one organization. Only authors who are not
   * bots, have a linked account and whose XISUITE user is currently a member of the organization
   * are returned; everyone else keeps their Git username. `host` is the repository's host key (ticket 11:
   * each server has its own accounts); the built-in host when omitted.
   */
  async resolveAuthors(
    organizationId: string,
    provider: GitProvider,
    authors: IGitAuthor[],
    host: string = this.hostOf(provider),
  ): Promise<Map<string, IResolvedAuthor>> {
    const externalIds = [
      ...new Set(
        authors
          .filter((author) => !isBotAuthor(author))
          .map((author) => author.externalId),
      ),
    ];

    return this.resolveBy(
      organizationId,
      provider,
      host,
      'external_user_id',
      externalIds,
      (externalId) =>
        authors.find((author) => author.externalId === externalId)?.login ?? '',
    );
  }

  /**
   * Ticket 6: the XISUITE person behind each Git username (GitHub push commits name the author by
   * username only), keyed by that username. Same rules as {@link resolveAuthors}.
   * ponytail: exact match; GitHub sends the canonical casing in both places.
   */
  async resolveLogins(
    organizationId: string,
    provider: GitProvider,
    logins: string[],
    host: string = this.hostOf(provider),
  ): Promise<Map<string, IResolvedAuthor>> {
    const unique = [
      ...new Set(logins.filter((login) => login && !isBotAuthor({ login }))),
    ];

    return this.resolveBy(
      organizationId,
      provider,
      host,
      'login',
      unique,
      (login) => login,
    );
  }

  /**
   * Ticket 9: the XISUITE person behind a webhook's sender, by provider user id, else by username
   * (same rules as {@link resolveAuthors}); null when unlinked, not a member or a bot.
   */
  async resolveActor(
    organizationId: string,
    provider: GitProvider,
    actor: IGitActor,
    host: string = this.hostOf(provider),
  ): Promise<IResolvedAuthor | null> {
    if (actor.externalId) {
      const byId = await this.resolveAuthors(
        organizationId,
        provider,
        [{ externalId: actor.externalId, login: actor.login ?? '' }],
        host,
      );
      const hit = byId.get(actor.externalId);

      if (hit) return hit;
    }

    if (!actor.login) return null;

    return (
      (
        await this.resolveLogins(organizationId, provider, [actor.login], host)
      ).get(actor.login) ?? null
    );
  }

  private async resolveBy(
    organizationId: string,
    provider: GitProvider,
    host: string,
    column: 'external_user_id' | 'login',
    values: string[],
    loginOf: (value: string) => string,
  ): Promise<Map<string, IResolvedAuthor>> {
    const resolved = new Map<string, IResolvedAuthor>();

    if (!values.length) return resolved;

    const links: { user_id: string; value: string }[] = [];

    for (const batch of chunk(values, ID_CHUNK)) {
      const { data, error } = await this.db
        .from(IDENTITIES)
        .select(`user_id, ${column}`)
        .eq('provider', provider)
        .eq('host', host)
        .in(column, batch);

      if (error) throw new InternalServerErrorException(error.message);

      for (const row of (data ?? []) as unknown as Record<string, string>[])
        links.push({ user_id: row.user_id, value: row[column] });
    }

    if (!links.length) return resolved;

    const members = await this.memberIds(
      organizationId,
      links.map((link) => link.user_id),
    );
    const users = await this.usersById(
      links
        .filter((link) => members.has(link.user_id))
        .map((link) => link.user_id),
    );

    for (const link of links) {
      const user = users.get(link.user_id);

      if (!user || !members.has(link.user_id)) continue;

      resolved.set(link.value, {
        userId: link.user_id,
        name: displayName(user, loginOf(link.value)),
        avatarUrl: user.avatar_url,
      });
    }

    return resolved;
  }
}
