import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestAutomationReaperService } from './test-automation-reaper.service';

interface Answer {
  data?: unknown;
  error: { message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Answer>;

function chainOf(answer: Answer): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'in',
    'lt',
    'gt',
    'or',
    'limit',
    'update',
    'maybeSingle',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (done: (value: Answer) => unknown) =>
      Promise.resolve(answer).then(done),
  });

  return chain;
}

describe('TestAutomationReaperService', () => {
  let service: TestAutomationReaperService;
  let from: jest.Mock;
  let remove: jest.Mock;

  const next = (answer: Answer): Chain => {
    const chain = chainOf(answer);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  const nothing = { data: [], error: null };
  const patch = (chain: Chain) =>
    (chain.update.mock.calls as Record<string, unknown>[][])[0][0];

  beforeEach(() => {
    from = jest.fn();
    remove = jest.fn().mockResolvedValue({ error: null });
    service = new TestAutomationReaperService({
      getClient: () => ({ from, storage: { from: () => ({ remove }) } }),
    } as unknown as SupabaseAdminService);
  });

  it('does nothing when no run is stuck', async () => {
    next(nothing);
    next(nothing);

    await service.reap();

    expect(from).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
  });

  it('closes a run whose lease ran out, and removes its zip copy', async () => {
    const read = next({
      data: [{ id: 'r1', run_zip_path: 'runs/a.zip' }],
      error: null,
    });
    const write = next({ data: { id: 'r1' }, error: null });

    next(nothing);

    await service.reap();

    expect(read.in).toHaveBeenCalledWith('status', ['RUNNING', 'UPLOADING']);
    expect(patch(write)).toMatchObject({
      status: 'ERROR',
      error_code: 'INTERRUPTED',
      lease_until: null,
      run_zip_path: null,
    });
    expect(patch(write)).toHaveProperty('finished_at');
    expect(write.eq).toHaveBeenCalledWith('id', 'r1');
    expect(write.in).toHaveBeenCalledWith('status', ['RUNNING', 'UPLOADING']);
    expect(write.lt).toHaveBeenCalledWith('lease_until', expect.any(String));
    expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
  });

  it('leaves a run alone when its heartbeat arrived after the read', async () => {
    next({ data: [{ id: 'r1', run_zip_path: 'runs/a.zip' }], error: null });
    next({ data: null, error: null });
    next(nothing);

    await service.reap();

    expect(remove).not.toHaveBeenCalled();
  });

  it('closes a run that waited over an hour with no runner', async () => {
    next(nothing);

    const read = next({
      data: [{ id: 'r2', run_zip_path: null, organization_id: 'org-1' }],
      error: null,
    });

    next(nothing);

    const write = next({ data: { id: 'r2' }, error: null });
    const before = Date.now();

    await service.reap();

    const cutoff = (read.lt.mock.calls as string[][])[0];

    expect(cutoff[0]).toBe('created_at');
    expect(before - Date.parse(cutoff[1])).toBeGreaterThanOrEqual(3_600_000);
    expect(before - Date.parse(cutoff[1])).toBeLessThan(3_660_000);
    expect(patch(write)).toMatchObject({ error_code: 'NO_RUNNER' });
    expect(write.in).toHaveBeenCalledWith('status', ['QUEUED']);
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not touch a run someone cancelled at the same moment', async () => {
    next(nothing);
    next({
      data: [
        { id: 'r2', run_zip_path: 'runs/b.zip', organization_id: 'org-1' },
      ],
      error: null,
    });
    next(nothing);
    next({ data: null, error: null });

    await service.reap();

    expect(remove).not.toHaveBeenCalled();
  });

  describe('a run waiting behind its organization’s active run', () => {
    const waiting = (id: string, org: string) => ({
      id,
      run_zip_path: null,
      organization_id: org,
    });

    it('is left to wait its turn', async () => {
      next(nothing);
      next({ data: [waiting('r2', 'org-1')], error: null });

      const busy = next({
        data: [{ organization_id: 'org-1' }],
        error: null,
      });

      await service.reap();

      expect(from).toHaveBeenCalledTimes(3);
      expect(busy.in).toHaveBeenCalledWith('status', ['RUNNING', 'UPLOADING']);
      expect(busy.gt).toHaveBeenCalledWith('lease_until', expect.any(String));
    });

    it('protects waiting runs of other organizations too, as a runner is clearly there', async () => {
      next(nothing);
      next({
        data: [waiting('r2', 'org-1'), waiting('r3', 'org-2')],
        error: null,
      });
      next({ data: [{ id: 'r1' }], error: null });

      await service.reap();

      expect(from).toHaveBeenCalledTimes(3);
    });

    it('asks nothing more when no run has waited long enough', async () => {
      next(nothing);
      next(nothing);

      await service.reap();

      expect(from).toHaveBeenCalledTimes(2);
    });

    it('closes nothing when active runs cannot be read', async () => {
      next(nothing);
      next({ data: [waiting('r2', 'org-1')], error: null });
      next({ data: null, error: { message: 'down' } });

      await expect(service.reap()).resolves.toBeUndefined();

      expect(from).toHaveBeenCalledTimes(3);
    });
  });

  describe('a run whose heartbeat goes on but whose steps never end', () => {
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    it('is read along with the runs whose lease ran out', async () => {
      const read = next(nothing);

      next(nothing);

      await service.reap();

      expect(read.or).toHaveBeenCalledWith(
        expect.stringMatching(
          /^lease_until\.lt\."[^"]+",started_at\.lt\."[^"]+"$/,
        ),
      );
    });

    it('is closed after a day even with a fresh lease', async () => {
      next({
        data: [{ id: 'r1', run_zip_path: 'runs/a.zip', started_at: longAgo }],
        error: null,
      });

      const write = next({ data: { id: 'r1' }, error: null });

      next(nothing);

      await service.reap();

      expect(patch(write)).toMatchObject({ error_code: 'INTERRUPTED' });
      expect(write.lt).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
    });

    it('still needs an expired lease for a run started recently', async () => {
      next({
        data: [
          {
            id: 'r1',
            run_zip_path: null,
            started_at: new Date().toISOString(),
          },
        ],
        error: null,
      });

      const write = next({ data: { id: 'r1' }, error: null });

      next(nothing);

      await service.reap();

      expect(write.lt).toHaveBeenCalledWith('lease_until', expect.any(String));
    });
  });

  it('survives a database problem and tries again next time', async () => {
    next({ data: null, error: { message: 'down' } });
    await expect(service.reap()).resolves.toBeUndefined();

    next(nothing);
    next(nothing);
    await service.reap();

    expect(from).toHaveBeenCalledTimes(3);
  });

  it('still closes the run when its zip cannot be removed', async () => {
    remove.mockResolvedValue({ error: { message: 'storage down' } });
    next({ data: [{ id: 'r1', run_zip_path: 'a.zip' }], error: null });
    next({ data: { id: 'r1' }, error: null });
    next(nothing);

    await expect(service.reap()).resolves.toBeUndefined();
  });

  it('never runs twice at the same time', async () => {
    let release: (answer: Answer) => void = () => undefined;
    const slow = chainOf(nothing);

    Object.assign(slow, {
      then: (done: (value: Answer) => unknown) =>
        new Promise<Answer>((resolve) => {
          release = resolve;
        }).then(done),
    });
    from.mockReturnValueOnce(slow);
    next(nothing);

    const first = service.reap();

    await service.reap();
    expect(from).toHaveBeenCalledTimes(1);

    release(nothing);
    await first;
  });
});
