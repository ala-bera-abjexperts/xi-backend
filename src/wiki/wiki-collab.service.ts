/**
 * @fileoverview Realtime co-editing backend for wiki pages (Wiki 2.0).
 *
 * Clients collaborate over Supabase Realtime private channels
 * (`wiki-collab:<pageId>`, authorized via the `wiki_topics` claim in a
 * backend-minted HS256 JWT) and periodically persist the merged Yjs state
 * here. The snapshot row (`wiki_page_collab_snapshots`) is the CAS point:
 * every save must present the current `seq` and the owning `sessionId`;
 * stale-session takeover is possible only after the 120s heartbeat TTL.
 * On every successful save the page row itself is updated with the sanitized
 * TipTap JSON + server-computed content_text so REST readers and search stay
 * consistent with the collab state.
 * @module src/wiki/wiki-collab.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { validateTipTapDoc } from '../common/utils/tiptap-sanitizer';
import {
  extractTipTapCommentThreadIds,
  tiptapToPlainText,
} from './wiki-content.util';
import { WikiService } from './wiki.service';
import { assertSchemaCompatible } from './wiki-schema-guard';
import { WikiCommentsService } from './wiki-comments.service';
import { WikiCollabBroadcastService } from './wiki-collab-broadcast.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { SaveCollabSnapshotDto } from './dto/collab-snapshot.dto';

/** Collab token lifetime (seconds). */
const TOKEN_TTL_SECONDS = 600;

/** A session is stale (and claimable) when its heartbeat is older than this. */
const SESSION_TTL_MS = 120_000;

interface SnapshotRow {
  wiki_page_id: string;
  organization_id: string;
  space_id: string;
  ydoc_state: string | null;
  state_vector: string | null;
  seq: number;
  active_session_id: string | null;
  session_heartbeat_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

interface VerifiedPage {
  id: string;
  organization_id: string;
  space_id: string;
  content_format: string | null;
  metadata: Record<string, unknown> | null;
  content?: unknown;
}

@Injectable()
export class WikiCollabService {
  private static readonly SNAPSHOTS = 'wiki_page_collab_snapshots';
  private static readonly PAGES = 'wiki_pages';
  private readonly logger = new Logger(WikiCollabService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly wikiService: WikiService,
    private readonly wikiComments: WikiCommentsService,
    private readonly broadcast: WikiCollabBroadcastService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Page verification ─────────────────────────────────────────────────────

  // Resolve the page org+space-verified BEFORE touching the snapshot row.
  // Every snapshot query below additionally carries the space_id scope.
  private async resolvePage(
    pageId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<VerifiedPage> {
    const page = (await this.wikiService.getPageById(
      pageId,
      spaceId,
    )) as Record<string, unknown>;

    if (page['organization_id'] !== organizationId) {
      throw new NotFoundException('Wiki page not found');
    }

    return {
      id: pageId,
      organization_id: organizationId,
      space_id: spaceId,
      content_format: (page['content_format'] as string | null) ?? null,
      metadata: (page['metadata'] as Record<string, unknown> | null) ?? null,
      content: page['content'],
    };
  }

  // ── bytea codecs (PostgREST hex format) ───────────────────────────────────

  /** base64 → PostgREST bytea hex string ('\x…'). */
  private b64ToHex(b64: string): string {
    return '\\x' + Buffer.from(b64, 'base64').toString('hex');
  }

  /** PostgREST bytea hex string ('\x…') → base64 (or null). */
  private hexToB64(value: unknown): string | null {
    if (typeof value !== 'string' || !value.startsWith('\\x')) return null;

    return Buffer.from(value.slice(2), 'hex').toString('base64');
  }

  // ── Token ─────────────────────────────────────────────────────────────────

  /**
   * Mints the short-lived HS256 Realtime JWT authorizing the caller to join
   * the page's private collab channel. Signed with SUPABASE_JWT_SECRET so
   * `realtime.messages` RLS can verify it; the `wiki_topics` claim carries the
   * single topic this token grants.
   */
  async mintToken(
    user: RequestUser,
    pageId: string,
  ): Promise<{ token: string; expiresAt: string; topic: string }> {
    const secret = this.configService.get<string>('supabase.jwtSecret');

    if (!secret) {
      throw new ServiceUnavailableException(
        'Realtime collaboration is not configured',
      );
    }

    // sub MUST be the auth.users id (Realtime treats it as the auth uid).
    let authUserId = user.authUserId;

    if (!authUserId) {
      const { data } = await this.client
        .from('users')
        .select('auth_user_id')
        .eq('id', user.userId)
        .maybeSingle();

      authUserId =
        (data as { auth_user_id?: string } | null)?.auth_user_id ?? '';
    }

    if (!authUserId) {
      throw new BadRequestException('Could not resolve auth identity');
    }

    const topic = `wiki-collab:${pageId}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + TOKEN_TTL_SECONDS;

    const token = await this.jwtService.signAsync(
      {
        iss: 'xisuite-backend',
        sub: authUserId,
        role: 'authenticated',
        aud: 'authenticated',
        iat: nowSec,
        exp: expSec,
        wiki_topics: [topic],
        app_user_id: user.userId,
        org_id: user.organizationId,
      },
      { secret, algorithm: 'HS256' },
    );

    return {
      token,
      expiresAt: new Date(expSec * 1000).toISOString(),
      topic,
    };
  }

  // ── Snapshot read ─────────────────────────────────────────────────────────

  /** Current snapshot state for a page (nulls when no snapshot exists yet). */
  async getSnapshot(
    user: RequestUser,
    pageId: string,
    spaceId: string,
  ): Promise<Record<string, unknown>> {
    await this.resolvePage(pageId, spaceId, user.organizationId);

    const { data, error } = await this.client
      .from(WikiCollabService.SNAPSHOTS)
      .select(
        'ydoc_state, state_vector, seq, active_session_id, session_heartbeat_at, updated_at',
      )
      .eq('wiki_page_id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);

    const row = data as Partial<SnapshotRow> | null;

    if (!row) {
      return {
        ydocState: null,
        stateVector: null,
        seq: 0,
        activeSessionId: null,
        sessionHeartbeatAt: null,
        updatedAt: null,
      };
    }

    return {
      ydocState: this.hexToB64(row.ydoc_state),
      stateVector: this.hexToB64(row.state_vector),
      seq: row.seq ?? 1,
      activeSessionId: row.active_session_id ?? null,
      sessionHeartbeatAt: row.session_heartbeat_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  // ── Snapshot write ────────────────────────────────────────────────────────

  /**
   * Persists a collab snapshot.
   *
   * - `seed: true` inserts the row iff none exists (409 SEED_CONFLICT
   *   otherwise) and seeds the page content via the sanitized update path
   *   with lazy-conversion semantics.
   * - Normal saves are a CAS: `WHERE seq = :seq AND (session owns row OR the
   *   previous session is stale/absent)`. Losers receive 409 SESSION_CONFLICT
   *   or SEQ_CONFLICT with the current values.
   * - `endSession: true` additionally releases the session and bumps the page
   *   version hint so the versioning trigger cuts a session-end version.
   */
  async saveSnapshot(
    user: RequestUser,
    pageId: string,
    spaceId: string,
    dto: SaveCollabSnapshotDto,
    schemaGuard?: { header?: string },
  ): Promise<Record<string, unknown>> {
    const page = await this.resolvePage(pageId, spaceId, user.organizationId);

    if (schemaGuard) {
      assertSchemaCompatible(page.content, dto.content, schemaGuard.header);
    }

    // Sanitize the TipTap content and compute the authoritative plain text
    // (the client's contentText is a hint only and is ignored).
    const validated = validateTipTapDoc(dto.content);
    const contentText = tiptapToPlainText(validated.doc);
    const nowIso = new Date().toISOString();

    if (dto.seed) {
      const inserted = await this.client
        .from(WikiCollabService.SNAPSHOTS)
        .upsert(
          {
            wiki_page_id: pageId,
            organization_id: page.organization_id,
            space_id: page.space_id,
            ydoc_state: this.b64ToHex(dto.ydocState),
            state_vector: dto.stateVector
              ? this.b64ToHex(dto.stateVector)
              : null,
            seq: 1,
            active_session_id: dto.endSession ? null : dto.sessionId,
            session_heartbeat_at: nowIso,
            updated_by: user.userId,
            updated_at: nowIso,
          },
          { onConflict: 'wiki_page_id', ignoreDuplicates: true },
        )
        .select('seq');
      if (inserted.error) throw new BadRequestException(inserted.error.message);

      if (!inserted.data || inserted.data.length === 0) {
        const existing = await this.readSnapshotRow(pageId, spaceId);

        throw new ConflictException({
          message: 'A collab snapshot already exists for this page',
          code: 'SEED_CONFLICT',
          data: {
            seq: existing?.seq ?? null,
            activeSessionId: existing?.active_session_id ?? null,
          },
        });
      }

      // Seed the page content through the sanitized update path with the
      // lazy-conversion claim (exactly one client wins the format flip).
      await this.wikiService.updatePage(
        pageId,
        spaceId,
        {
          content: validated.json,
          content_format: 'tiptap',
          convertedFrom:
            page.content_format && page.content_format !== 'tiptap'
              ? (page.content_format as 'editorjs' | 'html')
              : undefined,
          collabSessionId: dto.sessionId,
        },
        user.userId,
      );

      this.syncAnchorsBestEffort(pageId, validated.doc);

      if (dto.endSession) {
        await this.finishSession(page, dto.sessionId, user.userId);
      }

      return { seq: 1, updatedAt: nowIso };
    }

    // Normal save: atomic claim-then-save. The WHERE clause admits the owning
    // session, an unclaimed row, or a stale takeover — all in one UPDATE.
    const staleCutoffIso = new Date(Date.now() - SESSION_TTL_MS).toISOString();
    const newSeq = dto.seq + 1;

    const updatePayload: Record<string, unknown> = {
      ydoc_state: this.b64ToHex(dto.ydocState),
      seq: newSeq,
      active_session_id: dto.endSession ? null : dto.sessionId,
      session_heartbeat_at: nowIso,
      updated_by: user.userId,
      updated_at: nowIso,
    };

    if (dto.stateVector !== undefined) {
      updatePayload['state_vector'] = this.b64ToHex(dto.stateVector);
    }

    // Claim 1: we already own the row, or nobody does.
    //
    // The staleness case is deliberately NOT folded into this `.or()`. It used to
    // be, as `session_heartbeat_at.lt."<iso>"` — and an ISO timestamp inside a
    // PostgREST logical tree is exactly the shape that does not survive parsing,
    // so the clause silently never matched. An abandoned session therefore owned
    // the page forever: the CAS matched no row, and because the dead owner is by
    // definition NOT live, the error branch below reported the failure as
    // SEQ_CONFLICT quoting the seq the caller had just sent — a conflict the
    // client can never resolve, since no seq it can send will ever satisfy a
    // predicate that is false for reasons unrelated to seq. Editors fell back to
    // the bounded REST path and then stopped persisting altogether.
    let claim = await this.client
      .from(WikiCollabService.SNAPSHOTS)
      .update(updatePayload)
      .eq('wiki_page_id', pageId)
      .eq('space_id', spaceId)
      .eq('seq', dto.seq)
      .or(`active_session_id.eq.${dto.sessionId},active_session_id.is.null`)
      // `active_session_id` MUST stay in this projection. PostgREST resolves a
      // logical (or/and) tree on a mutation against the RETURNING projection, not
      // the plain WHERE clause, so narrowing this to `.select('seq')` makes the
      // column unresolvable and Postgres rejects the whole statement with 42703
      // "column ... does not exist" — for a column that plainly exists, and only
      // on UPDATE, which is why reads never showed it. Simple filters (see the
      // stale claim below) are unaffected.
      .select('seq, active_session_id')
      .maybeSingle();

    // Claim 2: the current owner's heartbeat has aged out. Still one atomic
    // conditional UPDATE (seq CAS + heartbeat cutoff), just expressed as plain
    // filters rather than inside a logical tree.
    if (!claim.error && !claim.data) {
      claim = await this.client
        .from(WikiCollabService.SNAPSHOTS)
        .update(updatePayload)
        .eq('wiki_page_id', pageId)
        .eq('space_id', spaceId)
        .eq('seq', dto.seq)
        .lt('session_heartbeat_at', staleCutoffIso)
        .select('seq')
        .maybeSingle();
    }

    // A driver/constraint error is NOT a CAS miss. Folding the two together (the
    // old `if (claim.error || !claim.data)`) meant any genuine write failure was
    // re-reported as SEQ_CONFLICT quoting the caller's own seq — an unresolvable
    // conflict that looks like normal control flow, so the client retried it
    // forever and the real error was never surfaced anywhere.
    if (claim.error) {
      this.logger.error(
        `collab snapshot claim failed for page ${pageId}: ${claim.error.message}` +
          (claim.error.details ? ` (${claim.error.details})` : ''),
      );

      throw new InternalServerErrorException(
        `Could not persist collab snapshot: ${claim.error.message}`,
      );
    }

    if (!claim.data) {
      const current = await this.readSnapshotRow(pageId, spaceId);

      if (!current) {
        throw new NotFoundException(
          'No collab snapshot exists for this page (seed it first)',
        );
      }

      const heartbeat = current.session_heartbeat_at
        ? Date.parse(current.session_heartbeat_at)
        : 0;
      const otherSessionLive =
        current.active_session_id &&
        current.active_session_id !== dto.sessionId &&
        heartbeat > Date.now() - SESSION_TTL_MS;

      if (otherSessionLive) {
        throw new ConflictException({
          message: 'Another collab session owns this page',
          code: 'SESSION_CONFLICT',
          data: { sessionId: current.active_session_id },
        });
      }

      throw new ConflictException({
        message: 'Snapshot seq is stale',
        code: 'SEQ_CONFLICT',
        data: { seq: current.seq },
      });
    }

    // Persist the sanitized content on the page row itself.
    await this.persistPageContent(
      page,
      validated.json,
      contentText,
      user.userId,
    );

    this.syncAnchorsBestEffort(pageId, validated.doc);

    if (dto.endSession) {
      await this.finishSession(page, dto.sessionId, user.userId);
    }

    return { seq: newSeq, updatedAt: nowIso };
  }

  /** Touches the session heartbeat (only when the session still owns the row). */
  async heartbeat(
    user: RequestUser,
    pageId: string,
    spaceId: string,
    sessionId: string,
  ): Promise<{ alive: boolean }> {
    await this.resolvePage(pageId, spaceId, user.organizationId);

    const { data, error } = await this.client
      .from(WikiCollabService.SNAPSHOTS)
      .update({ session_heartbeat_at: new Date().toISOString() })
      .eq('wiki_page_id', pageId)
      .eq('space_id', spaceId)
      .eq('active_session_id', sessionId)
      .select('wiki_page_id');
    if (error) throw new BadRequestException(error.message);

    return { alive: ((data ?? []) as unknown[]).length > 0 };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async readSnapshotRow(
    pageId: string,
    spaceId: string,
  ): Promise<Pick<
    SnapshotRow,
    'seq' | 'active_session_id' | 'session_heartbeat_at'
  > | null> {
    const { data } = await this.client
      .from(WikiCollabService.SNAPSHOTS)
      .select('seq, active_session_id, session_heartbeat_at')
      .eq('wiki_page_id', pageId)
      .eq('space_id', spaceId)
      .maybeSingle();

    return (data as SnapshotRow | null) ?? null;
  }

  // Direct page-content write used on every collab save (bypasses the full
  // updatePage pipeline: no outbox/mention storm per autosave). Handles the
  // rare mid-session format flip by bumping the version hint on conversion.
  private async persistPageContent(
    page: VerifiedPage,
    contentJson: string,
    contentText: string,
    userId: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      content: contentJson,
      content_text: contentText,
      content_format: 'tiptap',
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (page.content_format && page.content_format !== 'tiptap') {
      payload['metadata'] = {
        ...(page.metadata ?? {}),
        _version_hint: randomUUID(),
      };
      page.content_format = 'tiptap';
    }

    if (page.metadata?.blog_modified_at) {
      const { blog_modified_at: _sourceModified, ...metadata } = (payload['metadata'] ?? page.metadata) as Record<string, unknown>;
      payload['metadata'] = metadata;
    }

    const { error } = await this.client
      .from(WikiCollabService.PAGES)
      .update(payload)
      .eq('id', page.id)
      .eq('space_id', page.space_id)
      .eq('organization_id', page.organization_id);
    if (error) throw new BadRequestException(error.message);
  }

  // Session end: release the session (idempotent) and bump the page version
  // hint so the versioning trigger records a session-end boundary version.
  private async finishSession(
    page: VerifiedPage,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    await this.client
      .from(WikiCollabService.SNAPSHOTS)
      .update({ active_session_id: null })
      .eq('wiki_page_id', page.id)
      .eq('space_id', page.space_id)
      .eq('active_session_id', sessionId);

    const { data } = await this.client
      .from(WikiCollabService.PAGES)
      .select('metadata')
      .eq('id', page.id)
      .eq('space_id', page.space_id)
      .maybeSingle();
    const metadata =
      (data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {};

    await this.client
      .from(WikiCollabService.PAGES)
      .update({
        metadata: { ...metadata, _version_hint: randomUUID() },
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', page.id)
      .eq('space_id', page.space_id);

    void this.broadcast
      .broadcastControl(page.id, 'session_ended', { sessionId })
      .catch(() => undefined);
  }

  /** Fire-and-forget inline-anchor reconciliation after a content write. */
  private syncAnchorsBestEffort(pageId: string, doc: unknown): void {
    void this.wikiComments
      .syncAnchors(pageId, extractTipTapCommentThreadIds(doc))
      .catch((err) =>
        this.logger.warn(
          `syncAnchors failed for page ${pageId}: ${String(err)}`,
        ),
      );
  }
}
