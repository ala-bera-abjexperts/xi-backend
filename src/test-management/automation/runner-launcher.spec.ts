import { EventEmitter } from 'events';
import { join } from 'path';

import {
  BACKGROUND_COMMAND,
  RUNNER_LOG_FILE,
  RunnerLauncher,
} from './runner-launcher';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process') as { spawn: jest.Mock };

class FakeChild extends EventEmitter {
  unref = jest.fn();
}

type SpawnCall = [
  string,
  string[],
  { detached: boolean; cwd: string; stdio: string; env: NodeJS.ProcessEnv },
];

const spawnCall = () => spawn.mock.calls[0] as SpawnCall;

describe('RunnerLauncher', () => {
  const saved = { ...process.env };
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawn.mockReset().mockReturnValue(child);
    delete process.env.TM_RUNNER_IDLE_STOP_MINUTES;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('hands the source worker to a shell that leaves it running in the background', () => {
    process.env.NODE_ENV = 'development';

    new RunnerLauncher().launch(jest.fn());

    const [binary, args, options] = spawnCall();

    expect(binary).toBe('/bin/sh');
    expect(args).toEqual([
      '-c',
      BACKGROUND_COMMAND,
      'tm-runner',
      process.execPath,
      '-r',
      'ts-node/register',
      join(process.cwd(), 'src', 'test-automation-runner', 'runner.worker.ts'),
    ]);
    expect(options).toMatchObject({
      detached: true,
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    expect(options.env).toMatchObject({
      TM_RUNNER_WORKER: '1',
      TM_RUNNER_LOG: RUNNER_LOG_FILE,
      TM_RUNNER_IDLE_STOP_MINUTES: '15',
      TS_NODE_COMPILER_OPTIONS: '{"module":"CommonJS"}',
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it('keeps paths out of the command text', () => {
    expect(BACKGROUND_COMMAND).toBe('nohup "$@" >>"$TM_RUNNER_LOG" 2>&1 &');
  });

  it('starts the built worker in production and keeps a set idle time', () => {
    process.env.NODE_ENV = 'production';
    process.env.TM_RUNNER_IDLE_STOP_MINUTES = '30';

    new RunnerLauncher().launch(jest.fn());

    const [, args, options] = spawnCall();

    expect(args.slice(3)).toEqual([
      process.execPath,
      join(process.cwd(), 'dist', 'test-automation-runner', 'runner.worker.js'),
    ]);
    expect(options.env.TM_RUNNER_IDLE_STOP_MINUTES).toBe('30');
    expect(options.env.TS_NODE_COMPILER_OPTIONS).toBeUndefined();
  });

  it('reports a shell that cannot start or fails, not one that hands over', () => {
    const onFailed = jest.fn();

    new RunnerLauncher().launch(onFailed);
    child.emit('error', new Error('spawn ENOENT'));

    expect(onFailed).toHaveBeenCalledWith('spawn ENOENT');

    const failed = new FakeChild();

    spawn.mockReturnValue(failed);
    new RunnerLauncher().launch(onFailed);
    failed.emit('exit', 127);

    expect(onFailed).toHaveBeenLastCalledWith(
      'The test runner could not be started (127)',
    );

    onFailed.mockClear();

    const handedOver = new FakeChild();

    spawn.mockReturnValue(handedOver);
    new RunnerLauncher().launch(onFailed);
    handedOver.emit('exit', 0);

    expect(onFailed).not.toHaveBeenCalled();
  });
});
