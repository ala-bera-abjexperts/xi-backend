import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

import { Injectable } from '@nestjs/common';

const DEFAULT_IDLE_STOP_MINUTES = '15';

export const RUNNER_LOG_FILE = join(tmpdir(), 'xis-tm-runner-worker.log');

// The shell puts the runner in the background and exits, so the runner is no longer a child of the API and a
// reload or restart of the API does not stop it. Paths travel as arguments, never inside the command text.
export const BACKGROUND_COMMAND = 'nohup "$@" >>"$TM_RUNNER_LOG" 2>&1 &';

/** Starts the test runner as its own program, so restarting the API never stops its tests. */
@Injectable()
export class RunnerLauncher {
  /** onFailed covers the start itself; a runner that dies later shows up as a start that never came up. */
  launch(onFailed: (detail: string) => void): void {
    const root = process.cwd();
    const production = process.env.NODE_ENV === 'production';

    // In development the API rebuilds dist/ on every save, so the worker runs from the source instead.
    const args = production
      ? [join(root, 'dist', 'test-automation-runner', 'runner.worker.js')]
      : [
          '-r',
          'ts-node/register',
          join(root, 'src', 'test-automation-runner', 'runner.worker.ts'),
        ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TM_RUNNER_WORKER: '1',
      TM_RUNNER_LOG: RUNNER_LOG_FILE,
      TM_RUNNER_IDLE_STOP_MINUTES:
        process.env.TM_RUNNER_IDLE_STOP_MINUTES ?? DEFAULT_IDLE_STOP_MINUTES,
    };

    if (!production) {
      env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS' });
    }

    const shell = spawn(
      '/bin/sh',
      ['-c', BACKGROUND_COMMAND, 'tm-runner', process.execPath, ...args],
      { cwd: root, env, detached: true, stdio: 'ignore' },
    );

    shell.once('error', (error) => onFailed(error.message));
    shell.once('exit', (code) => {
      if (code !== 0) {
        onFailed(`The test runner could not be started (${code})`);
      }
    });
    shell.unref();
  }
}
