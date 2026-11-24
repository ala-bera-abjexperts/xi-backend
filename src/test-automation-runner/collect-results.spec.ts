import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { TEST_TRANSFER_LIMITS } from '../test-management/dto/test-transfer.dto';
import { parseJunit } from '../test-management/transfer/cucumber-results/junit.parser';
import {
  collectResults,
  MAX_RESULT_FILES,
  snapshotResults,
} from './collect-results';

const RUN = '11111111-1111-4111-8111-111111111111';
const JUNIT =
  '<testsuite><testcase classname="a" name="b"></testcase></testsuite>';

describe('collectResults', () => {
  let outside: string;
  let folder: string;

  const write = (path: string, content = JUNIT) => {
    const full = join(folder, path);

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);

    return full;
  };

  const paths = async (results: string[], workDir: string | null = null) =>
    (await collectResults(folder, workDir, results, RUN)).files.map(
      (file) => file.path,
    );

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'collect-outside-'));
    folder = mkdtempSync(join(tmpdir(), 'collect-run-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('finds a named file, inside the working folder when there is one', async () => {
    write('app/reports/results.xml');

    await expect(paths(['reports/results.xml'], 'app')).resolves.toEqual([
      'app/reports/results.xml',
    ]);
    await expect(paths(['reports/results.xml'])).resolves.toEqual([]);
  });

  it('expands a wildcard within one folder, in a stable order', async () => {
    write('target/surefire-reports/TEST-b.xml');
    write('target/surefire-reports/TEST-a.xml');
    write('target/surefire-reports/nested/TEST-c.xml');

    await expect(paths(['target/surefire-reports/*.xml'])).resolves.toEqual([
      'target/surefire-reports/TEST-a.xml',
      'target/surefire-reports/TEST-b.xml',
    ]);
  });

  it('matches wildcard characters only, not regular expression ones', async () => {
    write('a.b/r1.xml');
    write('axb/r2.xml');

    await expect(paths(['a.b/r?.xml'])).resolves.toEqual(['a.b/r1.xml']);
  });

  it('lists a file only once when two paths reach it', async () => {
    write('r/a.xml');

    await expect(paths(['r/a.xml', 'r/*.xml'])).resolves.toEqual(['r/a.xml']);
  });

  it('reports nothing for a path that was never written', async () => {
    await expect(
      collectResults(folder, null, ['missing/a.xml', 'missing/*.xml'], RUN),
    ).resolves.toEqual({ files: [], problems: [] });
  });

  describe('the run comment', () => {
    it('makes identical output from two runs different', async () => {
      write('a.xml');

      const [first] = (await collectResults(folder, null, ['a.xml'], RUN))
        .files;
      const [second] = (
        await collectResults(
          folder,
          null,
          ['a.xml'],
          '22222222-2222-4222-8222-222222222222',
        )
      ).files;

      expect(first.buffer.toString()).toContain(
        `<!-- xisuite-automation-run ${RUN}/1 -->`,
      );
      expect(first.buffer.equals(second.buffer)).toBe(false);
    });

    it('numbers the files of one run', async () => {
      write('a.xml');
      write('b.xml');

      const { files } = await collectResults(folder, null, ['*.xml'], RUN);

      expect(files[1].buffer.toString()).toContain(`${RUN}/2 -->`);
    });

    it('still reads as a JUnit file', async () => {
      write('a.xml');

      const [file] = (await collectResults(folder, null, ['a.xml'], RUN)).files;

      expect(parseJunit(file.buffer).testcases).toBe(1);
    });
  });

  describe('files from before the tests', () => {
    const results = ['reports/*.xml'];
    const later = new Date(Date.now() + 60_000);

    it('ignores an unchanged file and names it', async () => {
      write('reports/old.xml');

      const before = await snapshotResults(folder, null, results);
      const collected = await collectResults(
        folder,
        null,
        results,
        RUN,
        before,
      );

      expect(collected.files).toEqual([]);
      expect(collected.problems).toEqual([
        { path: join('reports', 'old.xml'), code: 'NOT_FROM_THIS_RUN' },
      ]);
    });

    it('counts a file the tests changed', async () => {
      const old = write('reports/old.xml');
      const before = await snapshotResults(folder, null, results);

      utimesSync(old, later, later);

      const collected = await collectResults(
        folder,
        null,
        results,
        RUN,
        before,
      );

      expect(collected.files.map((file) => file.name)).toEqual(['old.xml']);
      expect(collected.problems).toEqual([]);
    });

    it('counts a file the tests created', async () => {
      const before = await snapshotResults(folder, null, results);

      write('reports/new.xml');

      const collected = await collectResults(
        folder,
        null,
        results,
        RUN,
        before,
      );

      expect(collected.files.map((file) => file.name)).toEqual(['new.xml']);
    });

    it('keeps the old file on disk', async () => {
      const old = write('pom.xml');
      const before = await snapshotResults(folder, null, ['*.xml']);

      await collectResults(folder, null, ['*.xml'], RUN, before);

      expect(existsSync(old)).toBe(true);
    });

    it('counts everything without a record of what came before', async () => {
      write('reports/old.xml');

      await expect(paths(results)).resolves.toEqual([
        join('reports', 'old.xml'),
      ]);
    });
  });

  describe('what is refused', () => {
    it.each(['../secret.xml', 'a/../../secret.xml'])(
      'refuses %s without reading it',
      async (path) => {
        writeFileSync(join(folder, '..', 'secret.xml'), JUNIT);

        try {
          await expect(
            collectResults(folder, null, [path], RUN),
          ).resolves.toEqual({
            files: [],
            problems: [{ path, code: 'OUTSIDE_RUN_FOLDER' }],
          });
        } finally {
          rmSync(join(folder, '..', 'secret.xml'));
        }
      },
    );

    it('refuses a link to a file outside the run folder', async () => {
      writeFileSync(join(outside, 'secret.xml'), 'host secret');
      symlinkSync(join(outside, 'secret.xml'), join(folder, 'r.xml'));

      const result = await collectResults(folder, null, ['r.xml'], RUN);

      expect(result.files).toEqual([]);
      expect(result.problems).toEqual([{ path: 'r.xml', code: 'NOT_A_FILE' }]);
    });

    it('refuses a wildcard match that is a link', async () => {
      writeFileSync(join(outside, 'secret.xml'), 'host secret');
      symlinkSync(join(outside, 'secret.xml'), join(folder, 'r.xml'));

      const result = await collectResults(folder, null, ['*.xml'], RUN);

      expect(result.files).toEqual([]);
      expect(result.problems[0].code).toBe('NOT_A_FILE');
    });

    it('does not walk through a linked folder', async () => {
      writeFileSync(join(outside, 'secret.xml'), 'host secret');
      symlinkSync(outside, join(folder, 'reports'));

      await expect(
        collectResults(
          folder,
          null,
          ['reports/secret.xml', 'reports/*.xml'],
          RUN,
        ),
      ).resolves.toEqual({ files: [], problems: [] });
    });

    it('does not walk through a linked working folder', async () => {
      writeFileSync(join(outside, 'r.xml'), 'host secret');
      symlinkSync(outside, join(folder, 'app'));

      await expect(paths(['r.xml'], 'app')).resolves.toEqual([]);
    });

    it('refuses a folder named like a result file', async () => {
      mkdirSync(join(folder, 'r.xml'));

      const result = await collectResults(folder, null, ['r.xml'], RUN);

      expect(result.problems).toEqual([{ path: 'r.xml', code: 'NOT_A_FILE' }]);
    });

    it('does not hang on a named pipe', async () => {
      execFileSync('mkfifo', [join(folder, 'r.xml')]);

      const result = await collectResults(folder, null, ['r.xml'], RUN);

      expect(result.problems).toEqual([{ path: 'r.xml', code: 'NOT_A_FILE' }]);
    });

    it('refuses a file that is not XML', async () => {
      write('results.json', '{}');

      const result = await collectResults(folder, null, ['results.json'], RUN);

      expect(result.files).toEqual([]);
      expect(result.problems).toEqual([
        { path: 'results.json', code: 'NOT_XML' },
      ]);
    });

    it('accepts the size limit and refuses one byte more', async () => {
      const limit = TEST_TRANSFER_LIMITS.junitBytes;

      truncateSync(write('ok.xml'), limit);
      truncateSync(write('big.xml'), limit + 1);

      const result = await collectResults(
        folder,
        null,
        ['ok.xml', 'big.xml'],
        RUN,
      );

      expect(result.files.map((file) => file.path)).toEqual(['ok.xml']);
      expect(result.problems).toEqual([{ path: 'big.xml', code: 'TOO_LARGE' }]);
    });

    it('stops at the most files one run may send', async () => {
      for (let index = 0; index <= MAX_RESULT_FILES; index += 1) {
        write(`r/${String(index).padStart(2, '0')}.xml`);
      }

      const result = await collectResults(folder, null, ['r/*.xml'], RUN);

      expect(result.files).toHaveLength(MAX_RESULT_FILES);
      expect(result.problems).toEqual([
        { path: 'r/20.xml', code: 'TOO_MANY_FILES' },
      ]);
    });

    it('keeps the good files when another one is refused', async () => {
      write('a.xml');
      write('b.txt', 'x');

      const result = await collectResults(
        folder,
        null,
        ['a.xml', 'b.txt'],
        RUN,
      );

      expect(result.files.map((file) => file.name)).toEqual(['a.xml']);
      expect(result.problems).toEqual([{ path: 'b.txt', code: 'NOT_XML' }]);
    });
  });
});
