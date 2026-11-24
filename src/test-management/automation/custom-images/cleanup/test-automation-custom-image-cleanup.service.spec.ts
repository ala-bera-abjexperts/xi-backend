import { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import { TestAutomationCustomImageCleanupService } from './test-automation-custom-image-cleanup.service';

interface Resolved {
  data?: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function chainOf(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'in', 'or', 'limit', 'delete']) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

describe('TestAutomationCustomImageCleanupService', () => {
  let from: jest.Mock;
  let chains: Chain[];
  let warn: jest.SpyInstance;
  let service: TestAutomationCustomImageCleanupService;

  const answers = (...resolved: Resolved[]) => {
    for (const value of resolved) {
      const chain = chainOf(value);

      chains.push(chain);
      from.mockReturnValueOnce(chain);
    }
  };

  beforeEach(() => {
    chains = [];
    from = jest.fn();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    service = new TestAutomationCustomImageCleanupService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);
  });

  afterEach(() => warn.mockRestore());

  it('removes old refused images no setting uses, with the same conditions on the delete', async () => {
    answers(
      { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null },
      { data: [{ user_image_id: 'b' }], error: null },
      { data: null, error: null },
    );

    await service.removeOldRefusals();

    const [find, links, removal] = chains;

    expect(from.mock.calls).toEqual([
      ['test_automation_user_images'],
      ['test_automation_configs'],
      ['test_automation_user_images'],
    ]);
    expect(find.eq).toHaveBeenCalledWith('status', 'refused');
    expect(find.eq).toHaveBeenCalledWith('pulled_by_runner', false);
    expect(find.limit).toHaveBeenCalledWith(100);
    expect(links.in).toHaveBeenCalledWith('user_image_id', ['a', 'b', 'c']);
    expect(removal.delete).toHaveBeenCalled();
    expect(removal.in).toHaveBeenCalledWith('id', ['a', 'c']);
    expect(removal.eq).toHaveBeenCalledWith('status', 'refused');
    expect(removal.eq).toHaveBeenCalledWith('pulled_by_runner', false);
    expect(removal.or).toHaveBeenCalledWith(
      (find.or.mock.calls as string[][])[0][0],
    );
  });

  it('counts a refusal without a check time from its last change', async () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    answers({ data: [], error: null });

    await service.removeOldRefusals();
    clock.mockRestore();

    expect(chains[0].or).toHaveBeenCalledWith(
      'checked_at.lt."2026-11-17T12:00:00.000Z",' +
        'and(checked_at.is.null,updated_at.lt."2026-11-17T12:00:00.000Z")',
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('removes nothing when every old image is still used', async () => {
    answers(
      { data: [{ id: 'a' }], error: null },
      { data: [{ user_image_id: 'a' }], error: null },
    );

    await service.removeOldRefusals();

    expect(from).toHaveBeenCalledTimes(2);
  });

  it('stays quiet before the migration, and logs any other error without failing', async () => {
    answers({ error: { code: '42P01', message: 'missing' } });
    await service.removeOldRefusals();
    expect(warn).not.toHaveBeenCalled();

    answers({ error: { code: '08006', message: 'connection lost' } });
    await service.removeOldRefusals();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('connection lost'),
    );

    answers(
      { data: [{ id: 'a' }], error: null },
      { data: [], error: null },
      { error: { code: '55P03', message: 'busy' } },
    );
    await expect(service.removeOldRefusals()).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('busy'));
  });

  it('never runs twice at the same time', async () => {
    let release: (value: Resolved) => void = () => {};
    const slow = chainOf({ data: [], error: null });

    Object.assign(slow, {
      then: (onFulfilled: (value: Resolved) => unknown) =>
        new Promise<Resolved>((resolve) => {
          release = resolve;
        }).then(onFulfilled),
    });
    from.mockReturnValueOnce(slow);

    const first = service.removeOldRefusals();

    await service.removeOldRefusals();
    release({ data: [], error: null });
    await first;

    expect(from).toHaveBeenCalledTimes(1);
  });
});
