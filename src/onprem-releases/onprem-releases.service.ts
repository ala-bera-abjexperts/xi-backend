import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PublishReleaseDto } from './dto/publish-release.dto';

const SEMVER = /^\d+\.\d+\.\d+$/;

export interface LatestRelease {
  version: string | null;
  notes?: string | null;
  publishedAt?: string | null;
}

/**
 * Serves the "latest on-prem release" manifest that each on-prem client's updater
 * (update-agent.sh) fetches to discover updates. SaaS-hosted; reads/writes the
 * additive `public.onprem_releases` table via the service-role client.
 */
@Injectable()
export class OnpremReleasesService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Highest-SEMVER release on the channel (NOT most-recently-inserted), so
   * re-publishing notes for an older version can never downgrade clients.
   * Returns { version: null } when nothing has been published.
   */
  async getLatest(channel = 'stable'): Promise<LatestRelease> {
    const { data, error } = await this.client
      .from('onprem_releases')
      .select('version, notes, published_at')
      .eq('channel', channel);
    if (error) throw new InternalServerErrorException(error.message);

    const rows = (
      (data as Array<{
        version: string;
        notes: string | null;
        published_at: string;
      }>) || []
    ).filter((r) => SEMVER.test(r.version));
    if (rows.length === 0) return { version: null };

    rows.sort((a, b) => OnpremReleasesService.cmpSemver(b.version, a.version));
    const top = rows[0];

    return {
      version: top.version,
      notes: top.notes ?? null,
      publishedAt: top.published_at,
    };
  }

  /** Publish (upsert by version) a release row. Idempotent on re-publish. */
  async publish(dto: PublishReleaseDto, createdBy?: string) {
    const { data, error } = await this.client
      .from('onprem_releases')
      .upsert(
        {
          version: dto.version,
          notes: dto.notes ?? null,
          channel: dto.channel ?? 'stable',
          created_by: createdBy ?? null,
        },
        { onConflict: 'version' },
      )
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);

    return data;
  }

  /** Numeric X.Y.Z comparison: >0 if a>b, <0 if a<b, 0 if equal. */
  private static cmpSemver(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }

    return 0;
  }
}
