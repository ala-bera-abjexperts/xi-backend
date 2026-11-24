import { spawnSync } from 'child_process';
import path from 'path';
import { setupMetrics } from './metrics';

describe('setupMetrics', () => {
  it('returns no middleware when METRICS_PORT is unset', () => {
    expect(setupMetrics(undefined)).toBeNull();
    expect(setupMetrics('0')).toBeNull();
  });

  it('does not keep the process alive once everything else is done (SIGTERM exits)', () => {
    // A child process that only starts the metrics server must exit by itself.
    const file = path.join(__dirname, 'metrics.ts');
    const child = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        `require(${JSON.stringify(file)}).setupMetrics(String(20000 + Math.floor(Math.random() * 20000)))`,
      ],
      { timeout: 15_000, encoding: 'utf8' },
    );

    expect(child.error).toBeUndefined(); // ETIMEDOUT here = the server held the event loop open
    expect(child.status).toBe(0);
  });
});
