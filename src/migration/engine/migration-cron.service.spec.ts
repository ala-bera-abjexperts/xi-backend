import { MigrationCronService } from './migration-cron.service';
import type { MigrationTickService } from './migration-tick.service';
import type { MigrationWorkerService } from './migration-worker.service';

type RunnableCron = { runWork(): Promise<void> };

describe('MigrationCronService', () => {
  it('drains ready batches immediately until the queue is empty', async () => {
    const worker = {
      runWorkerLoop: jest
        .fn()
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(4))
        .mockResolvedValueOnce(stats(0)),
    };
    const service = new MigrationCronService(
      {} as MigrationTickService,
      worker as unknown as MigrationWorkerService,
    );

    await (service as unknown as RunnableCron).runWork();

    expect(worker.runWorkerLoop).toHaveBeenCalledTimes(3);
  });

  it('bounds one busy burst to ten batches', async () => {
    const worker = {
      runWorkerLoop: jest
        .fn()
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(25))
        .mockResolvedValueOnce(stats(0)),
    };
    const service = new MigrationCronService(
      {} as MigrationTickService,
      worker as unknown as MigrationWorkerService,
    );

    await (service as unknown as RunnableCron).runWork();

    expect(worker.runWorkerLoop).toHaveBeenCalledTimes(10);
  });

  it('stops the current burst after shutdown begins', async () => {
    const worker = { runWorkerLoop: jest.fn() };
    const service = new MigrationCronService(
      {} as MigrationTickService,
      worker as unknown as MigrationWorkerService,
    );
    worker.runWorkerLoop
      .mockImplementationOnce(() => {
        service.onModuleDestroy();
        return Promise.resolve(stats(25));
      })
      .mockResolvedValue(stats(0));

    await (service as unknown as RunnableCron).runWork();

    expect(worker.runWorkerLoop).toHaveBeenCalledTimes(1);
  });
});

function stats(leased: number) {
  return {
    leased,
    succeeded: leased,
    skipped: 0,
    blocked: 0,
    failed: 0,
    produced: 0,
  };
}
