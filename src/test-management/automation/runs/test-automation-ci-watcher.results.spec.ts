import { BadRequestException, ConflictException, Logger } from '@nestjs/common';

import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TestExecutionsService } from '../../executions/test-executions.service';
import type { TestPlanTestsService } from '../../plans/test-plan-tests.service';
import type { TestRunsService } from '../../runs/test-runs.service';
import type { CucumberResultsService } from '../../transfer/cucumber-results/cucumber-results.service';
import { readZipEntries } from '../../transfer/shared/zip-entries';
import type { RunRow } from '../test-automation-ci.service';
import { TestAutomationCiWatcherService } from '../test-automation-ci-watcher.service';
import type { TestAutomationGitService } from '../test-automation-git.service';
import {
  downloadArtifact,
  GithubActionsError,
  listArtifacts,
} from '../test-automation-github.client';

jest.mock('../test-automation-github.client', () => ({
  ...jest.requireActual<object>('../test-automation-github.client'),
  listArtifacts: jest.fn(),
  downloadArtifact: jest.fn(),
}));

jest.mock('../../transfer/shared/zip-entries', () => ({
  readZipEntries: jest.fn(),
}));

const REPORT = Buffer.from(
  '<testsuite name="s" tests="1"><testcase classname="c" name="n"/></testsuite>',
);
const FAILING_REPORT = Buffer.from(
  '<testsuite name="s" tests="1"><testcase classname="c" name="n"><failure/></testcase></testsuite>',
);
const CUT_OFF_REPORT = Buffer.from('<testsuite name="s"><testcase name="n">');
const DOCTYPE_REPORT = Buffer.from('<!DOCTYPE x><testsuite name="s"/>');
const NOT_A_REPORT = Buffer.from(
  '<project><artifactId>a</artifactId></project>',
);

const ROW = {
  id: 'run-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  target: 'execution',
  execution_id: 'exec-1',
  plan_id: null,
  started_by: 'user-1',
} as unknown as RunRow;

const ACCESS = { token: 'ghs_token' };
const CI = { state: 'importing', full_name: 'acme/tests', run_id: 123 };

interface Recorded {
  state: string;
  message?: string;
  summary?: { import?: Record<string, unknown> };
}

interface Internals {
  record(
    row: RunRow,
    access: unknown,
    ci: unknown,
    conclusion: string | null,
  ): Promise<Recorded>;
}

const artifact = (name: string, id = 1, extra: object = {}) => ({
  id,
  name,
  size_in_bytes: 10,
  expired: false,
  ...extra,
});

describe('TestAutomationCiWatcherService, recording results', () => {
  const list = listArtifacts as jest.Mock;
  const download = downloadArtifact as jest.Mock;
  const unzip = readZipEntries as jest.Mock;
  const commit = jest.fn();
  const remove = jest.fn();

  const service = new TestAutomationCiWatcherService(
    {} as unknown as SupabaseAdminService,
    {} as unknown as TestAutomationGitService,
    {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    } as unknown as TestManagementAccessService,
    {
      hasSpacePermission: jest.fn().mockResolvedValue(true),
    } as unknown as PermissionsService,
    { commit } as unknown as CucumberResultsService,
    { remove } as unknown as TestExecutionsService,
    {} as unknown as TestRunsService,
    {} as unknown as TestPlanTestsService,
  ) as unknown as Internals;

  const record = (conclusion: string | null = 'success', row = ROW) =>
    service.record(row, ACCESS, CI, conclusion);

  const withEntries = (...entries: { name: string; data: Buffer }[]) => {
    list.mockResolvedValue([artifact('results')]);
    unzip.mockResolvedValue({ entries, skipped: [] });
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    list.mockReset();
    download.mockReset().mockResolvedValue(Buffer.from('zip'));
    unzip.mockReset();
    remove.mockReset();
    commit.mockReset().mockResolvedValue({
      applied: [{}],
      created_cases: [],
      warnings: [],
      file_saved: true,
    });
  });

  describe('files that are left out', () => {
    it('names an unreadable JUnit report beside a good one, keeping the pass', async () => {
      withEntries(
        { name: 'dir/good.xml', data: REPORT },
        { name: 'dir/bad.xml', data: CUT_OFF_REPORT },
      );

      await expect(record()).resolves.toMatchObject({
        state: 'passed',
        message: 'Left out: bad.xml (a JUnit report that could not be read).',
      });
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['cut off', CUT_OFF_REPORT],
      ['using a DOCTYPE', DOCTYPE_REPORT],
    ])('does not pass a run whose only report is %s', async (_name, data) => {
      withEntries({ name: 'bad.xml', data });

      const recorded = await record();

      expect(recorded.state).toBe('no_results');
      expect(recorded.message).toContain(
        'bad.xml (a JUnit report that could not be read)',
      );
      expect(recorded.message).not.toContain('upload-artifact');
      expect(commit).not.toHaveBeenCalled();
    });

    it('says so on a failed workflow too', async () => {
      withEntries({ name: 'bad.xml', data: CUT_OFF_REPORT });

      await expect(record('failure')).resolves.toMatchObject({
        state: 'failed',
        message: expect.stringMatching(
          /saved no readable result file Left out: bad\.xml/,
        ) as string,
      });
    });

    it('does not name XML that is not a report', async () => {
      withEntries(
        { name: 'good.xml', data: REPORT },
        { name: 'pom.xml', data: NOT_A_REPORT },
      );

      const recorded = await record();

      expect(recorded.state).toBe('passed');
      expect(recorded.message).toBeUndefined();
    });

    it('asks for an upload step only when nothing was saved at all', async () => {
      list.mockResolvedValue([]);

      await expect(record()).resolves.toMatchObject({
        state: 'no_results',
        message: expect.stringContaining('upload-artifact') as string,
      });
    });

    it('names expired, oversized and surplus artifacts', async () => {
      list.mockResolvedValue([
        artifact('old', 1, { expired: true }),
        artifact('huge', 2, { size_in_bytes: 101 * 1024 * 1024 }),
        ...Array.from({ length: 11 }, (_, index) =>
          artifact(`a${index}`, 10 + index),
        ),
      ]);
      unzip.mockResolvedValue({ entries: [], skipped: [] });

      const recorded = await record();

      expect(recorded.message).toContain(
        'old (expired or over the size limit)',
      );
      expect(recorded.message).toContain(
        'huge (expired or over the size limit)',
      );
      expect(recorded.message).toContain('a10 (past the first 10)');
      expect(download).toHaveBeenCalledTimes(10);
    });

    it('names an artifact that cannot be unpacked', async () => {
      list.mockResolvedValue([artifact('broken')]);
      unzip.mockRejectedValue(new Error('not a zip'));

      await expect(record()).resolves.toMatchObject({
        state: 'no_results',
        message: expect.stringContaining(
          'broken (could not be unpacked)',
        ) as string,
      });
    });

    it('names a file over the size limit', async () => {
      withEntries(
        { name: 'good.xml', data: REPORT },
        { name: 'big.xml', data: Buffer.alloc(25 * 1024 * 1024 + 1) },
      );

      await expect(record()).resolves.toMatchObject({
        message: 'Left out: big.xml (over the file size limit).',
      });
    });

    it('says when there are more result files than it takes', async () => {
      withEntries(
        ...Array.from({ length: 21 }, (_, index) => ({
          name: `r${index}.xml`,
          data: REPORT,
        })),
      );

      await expect(record()).resolves.toMatchObject({
        message: 'Left out: result files past the first 20.',
      });
      expect(commit).toHaveBeenCalledTimes(20);
    });

    it('shows five names and counts the rest', async () => {
      withEntries(
        { name: 'good.xml', data: REPORT },
        ...Array.from({ length: 7 }, (_, index) => ({
          name: `bad${index}.xml`,
          data: CUT_OFF_REPORT,
        })),
      );

      const { message } = await record();

      expect(message).toContain('bad4.xml');
      expect(message).not.toContain('bad5.xml');
      expect(message).toContain('and 2 more.');
    });

    it('still retries a temporary GitHub failure', async () => {
      list.mockResolvedValue([artifact('results')]);
      download.mockRejectedValue(new GithubActionsError(500, 'try later'));

      await expect(record()).rejects.toBeInstanceOf(GithubActionsError);
    });
  });

  describe('marking a report with its run', () => {
    const sent = () => {
      const [, , , file] = commit.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        Express.Multer.File,
      ];

      return file;
    };

    it('marks JUnit XML, so a re-run of the same report is recorded', async () => {
      withEntries({ name: 'r.xml', data: REPORT });

      await record();

      const file = sent();

      expect(file.buffer.toString()).toContain(
        '<!-- xisuite-automation-run run-1 -->',
      );
      expect(file.size).toBe(file.buffer.length);
    });

    it('gives another run another mark', async () => {
      withEntries({ name: 'r.xml', data: REPORT });

      await record('success', { ...ROW, id: 'run-2' });

      expect(sent().buffer.toString()).toContain('run-2');
    });

    it('still counts failed tests from the report', async () => {
      withEntries({ name: 'r.xml', data: FAILING_REPORT });

      await expect(record()).resolves.toMatchObject({ state: 'failed' });
    });

    it('counts a marked file this run already recorded as done', async () => {
      withEntries({ name: 'r.xml', data: REPORT });
      commit.mockRejectedValue(
        new ConflictException({ code: 'IMPORT_ALREADY_APPLIED' }),
      );

      const recorded = await record();

      expect(recorded.state).toBe('passed');
      expect(recorded.message).toBeUndefined();
    });
  });

  describe('a report with nothing to record', () => {
    it('gives the reason from the results service', async () => {
      withEntries({ name: 'r.xml', data: REPORT });
      commit.mockRejectedValue(
        new BadRequestException({
          code: 'NOTHING_TO_APPLY',
          message: 'no test here matches c.n',
        }),
      );

      const recorded = await record();

      expect(recorded.state).toBe('no_results');
      expect(recorded.message).toContain('no test here matches c.n');
      expect(recorded.message).toContain('are not created from CI runs');
    });

    it('removes the empty execution of a plan run', async () => {
      withEntries({ name: 'r.xml', data: REPORT });
      commit.mockRejectedValue(
        new BadRequestException({ code: 'NOTHING_TO_APPLY', message: 'none' }),
      );

      await record('success', {
        ...ROW,
        target: 'plan',
      } as unknown as RunRow);

      expect(remove).toHaveBeenCalledTimes(1);
    });
  });
});
