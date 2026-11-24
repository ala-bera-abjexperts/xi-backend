import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SAAS_MIGRATION = resolve(
  process.cwd(),
  '../risk-management-app/supabase/migrations/20260902120000_space_deletion_cleanup_jobs.sql',
);
const ON_PREM_MIGRATION = resolve(
  process.cwd(),
  '../xisuite-infra/onprem/migrations/20260902120001_space_deletion_cleanup_jobs.sql',
);
const SAAS_PATH_FIX = resolve(
  process.cwd(),
  '../risk-management-app/supabase/migrations/20260902133000_normalize_wiki_storage_routes_for_space_deletion.sql',
);
const SAAS_REASSERT = resolve(
  process.cwd(),
  '../risk-management-app/supabase/migrations/20260915110000_space_deletion_cleanup_jobs_reassert.sql',
);
const ON_PREM_PATH_FIX = resolve(
  process.cwd(),
  '../xisuite-infra/onprem/migrations/20260902133001_normalize_wiki_storage_routes_for_space_deletion.sql',
);

describe('space deletion cleanup migration contract', () => {
  const load = (path: string) => readFileSync(path, 'utf8');

  it('keeps the forward SaaS and on-prem contracts equivalent', () => {
    expect(load(ON_PREM_MIGRATION)).toBe(load(SAAS_MIGRATION));
    expect(load(ON_PREM_PATH_FIX)).toBe(load(SAAS_PATH_FIX));
  });

  it('normalizes canonical relative wiki storage routes without accepting arbitrary absolute paths', () => {
    const sql = load(SAAS_PATH_FIX);

    expect(sql).toContain("p_bucket = 'wiki-attachments'");
    expect(sql).toContain(
      "'^/storage/v1/object/(?:public|sign)/wiki-attachments/([^?#]+)'",
    );
    expect(sql).toContain("'^https?://'");
    expect(sql).toContain(
      "'/object/(?:public|sign)/wiki-attachments/([^?#]+)'",
    );
    expect(sql).toContain("OR v_path LIKE '/%'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.normalize_space_deletion_storage_path(text, text)',
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.normalize_space_deletion_storage_path\(text, text\)\s+TO service_role/,
    );
  });

  it('atomically snapshots safe storage scopes before deleting the archived space', () => {
    const sql = load(SAAS_MIGRATION);
    const rpc = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.delete_space_cascade'),
    );

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.space_deletion_jobs',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.space_deletion_scopes',
    );
    expect(sql).not.toMatch(
      /space_deletion_jobs[\s\S]*REFERENCES public\.spaces/,
    );
    expect(rpc).toMatch(/FROM public\.spaces[\s\S]*FOR UPDATE/);
    expect(rpc).toMatch(/organization_id = p_organization_id/);
    expect(rpc).toMatch(/is_archived/);
    expect(
      rpc.indexOf('INSERT INTO public.space_deletion_scopes'),
    ).toBeLessThan(rpc.indexOf('DELETE FROM public.spaces'));
    expect(rpc).toContain("'exact'");
    expect(rpc).toContain("'prefix'");
    expect(rpc).toContain("'file-explorer'");
    expect(rpc).toContain("'form_builder_submission_attachments'");
    expect(rpc).toContain("'wiki-images/'");
    expect(rpc).toContain("'wiki-files/'");
    expect(rpc).toContain("'wiki/' || wp.id::text");
    expect(rpc).toContain("'space-icons'");
    expect(rpc).toMatch(
      /fa\.entity_type = 'task'[\s\S]*THEN 'task-attachments'/,
    );
    expect(rpc).not.toContain('editor-images');
  });

  it('leases work with SKIP LOCKED and verifies prefixes again after settling', () => {
    const sql = load(SAAS_MIGRATION);

    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.claim_space_deletion_scopes\([\s\S]*p_worker_id text[\s\S]*p_limit integer[\s\S]*p_space_id uuid DEFAULT NULL/,
    );
    expect(sql).toMatch(/FOR UPDATE(?: OF s)? SKIP LOCKED/);
    expect(sql).toMatch(/lease_expires_at[\s\S]*interval '5 minutes'/);
    expect(sql).toMatch(/next_attempt_at <= clock_timestamp\(\)/);
    expect(sql).toMatch(/settle_after[\s\S]*interval '2 hours'/);
    expect(sql).toMatch(/prefix_verified_after_settle/);
    expect(sql).toMatch(
      /WHEN s\.kind = 'prefix'[\s\S]*clock_timestamp\(\) < j\.settle_after[\s\S]*j\.settle_after/,
    );
    expect(sql).toMatch(/attempt_count >= max_attempts/);
  });

  it('re-asserts the full deletion schema for environments that skipped the original migration', () => {
    // Cloud production applied the path fix but not the original migration, so the RPC the
    // backend calls on DELETE /spaces/:id?hard=true did not exist there (HTTP 500).
    const sql = load(SAAS_REASSERT);

    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.space_deletion_jobs',
    );
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.space_deletion_scopes',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.delete_space_cascade',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.delete_space_cascade(uuid, uuid, uuid) TO service_role',
    );

    // The last normalizer definition wins, so it must be the one that accepts relative wiki routes.
    const lastNormalizer = sql.slice(
      sql.lastIndexOf(
        'CREATE OR REPLACE FUNCTION public.normalize_space_deletion_storage_path',
      ),
    );
    expect(lastNormalizer).toContain(
      "'^/storage/v1/object/(?:public|sign)/wiki-attachments/([^?#]+)'",
    );
    expect(lastNormalizer).toContain("OR v_path LIKE '/%'");
  });

  it('exposes deletion and worker helpers only to the service role', () => {
    const sql = load(SAAS_MIGRATION);

    for (const helper of [
      'delete_space_cascade',
      'claim_space_deletion_scopes',
      'complete_space_deletion_scope',
      'release_space_deletion_scope',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${helper}`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${helper}`);
    }
    expect(sql).toContain('TO service_role');
  });
});
