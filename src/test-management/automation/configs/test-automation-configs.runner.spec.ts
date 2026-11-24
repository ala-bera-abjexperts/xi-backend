import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { assertPublicHttpUrl } from '../../../common/security/ssrf-guard';
import { packSecretForStorage } from '../../../lib/crypto/encryption';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type {
  CreateTestAutomationConfigDto,
  UpdateTestAutomationConfigDto,
} from '../../dto/test-automation.dto';
import { DeleteTestAutomationFilesDto } from '../../dto/test-automation.dto';
import {
  AUTOMATION_BUCKET,
  readSecretMap,
  TestAutomationConfigsService,
  toConfig,
  type TestAutomationConfigRow,
} from '../test-automation-configs.service';
import type { TestAutomationGitService } from '../test-automation-git.service';
import { checkZip } from '../zip-check';
import {
  listZipFiles,
  readZipFile,
  rebuildZip,
  ZipFileError,
} from '../zip-files';

jest.mock('../../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
}));
jest.mock('../zip-check', () => ({ checkZip: jest.fn() }));
jest.mock('../zip-files', () => ({
  ...jest.requireActual<typeof import('../zip-files')>('../zip-files'),
  listZipFiles: jest.fn(),
  readZipFile: jest.fn(),
  rebuildZip: jest.fn(),
}));

const ORG = 'org-1';
const SPACE = 'space-1';
const CONFIG = 'config-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const IMAGE = `mcr.example.com/pw@sha256:${'a'.repeat(64)}`;

interface Resolved {
  data?: unknown;
  count?: number | null;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function chainOf(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'in',
    'or',
    'is',
    'not',
    'order',
    'insert',
    'update',
    'delete',
    'single',
    'maybeSingle',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function firstArg(mock: jest.Mock): Record<string, unknown> {
  return (mock.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
}

function ciRow(
  overrides: Partial<TestAutomationConfigRow> = {},
): TestAutomationConfigRow {
  return {
    id: CONFIG,
    name: 'Nightly',
    kind: 'ci_job',
    preset: null,
    image_key: null,
    source: null,
    repo_url: null,
    repo_ref: null,
    work_dir: null,
    zip_path: null,
    command: null,
    result_paths: [],
    env: {},
    secrets_enc: null,
    allowed_hosts: [],
    create_unmatched: false,
    timeout_minutes: 30,
    trace_mode: 'off',
    ci_url: 'https://ci.example.com/job/a?token=hidden',
    ci_method: 'POST',
    ci_headers_enc: null,
    ci_body_template: '{"token":"body-token"}',
    archived_at: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

function dockerRow(
  overrides: Partial<TestAutomationConfigRow> = {},
): TestAutomationConfigRow {
  return ciRow({
    kind: 'docker',
    preset: 'playwright',
    image_key: 'playwright',
    source: 'zip',
    result_paths: ['results.xml'],
    ci_url: null,
    ci_method: null,
    ci_body_template: null,
    ...overrides,
  });
}
describe('TestAutomationConfigsService, runner settings', () => {
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;
  const savedImages = process.env.TM_RUNNER_IMAGES;
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  const zipCheck = checkZip as jest.Mock;

  let service: TestAutomationConfigsService;
  let from: jest.Mock;
  let upload: jest.Mock;
  let remove: jest.Mock;
  let download: jest.Mock;
  let storageList: jest.Mock;
  let connectedRepositories: jest.Mock;
  let storageFrom: jest.Mock;
  let assertAvailable: jest.Mock;
  let log: jest.Mock;
  let hasSpacePermission: jest.Mock;

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  const auditMeta = (): string =>
    JSON.stringify((log.mock.calls as unknown[][])[0]?.[4]);

  const refusal = async (run: Promise<unknown>) => {
    const error: unknown = await run.then(
      () => {
        throw new Error('Expected the call to be refused');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BadRequestException);

    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  };

  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    process.env.TM_RUNNER_IMAGES = JSON.stringify({ playwright: IMAGE });
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;

    if (savedImages === undefined) delete process.env.TM_RUNNER_IMAGES;
    else process.env.TM_RUNNER_IMAGES = savedImages;
  });

  beforeEach(() => {
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    zipCheck.mockReset();
    zipCheck.mockResolvedValue(null);

    from = jest.fn();
    upload = jest.fn().mockResolvedValue({ error: null });
    remove = jest.fn().mockResolvedValue({ error: null });
    download = jest.fn().mockResolvedValue({
      data: new Blob([Buffer.from('zip')]),
      error: null,
    });
    storageList = jest.fn().mockResolvedValue({ data: [], error: null });
    storageFrom = jest.fn(() => ({
      upload,
      remove,
      download,
      list: storageList,
    }));
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    log = jest.fn();
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    connectedRepositories = jest
      .fn()
      .mockResolvedValue([{ web_url: 'https://g/a.git', provider: 'gitlab' }]);

    service = new TestAutomationConfigsService(
      {
        getClient: () => ({ from, storage: { from: storageFrom } }),
      } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { hasSpacePermission } as unknown as PermissionsService,
      { connectedRepositories } as unknown as TestAutomationGitService,
    );
  });

  describe('what a reader sees', () => {
    it('shows commands only to someone who can edit', () => {
      const row = dockerRow({ command: 'pytest -q', install_command: 'pip i' });

      expect(toConfig(row, true)).toMatchObject({
        command: 'pytest -q',
        install_command: 'pip i',
      });
      expect(toConfig(row, false)).toMatchObject({
        command: null,
        install_command: null,
      });
      expect(JSON.stringify(toConfig(row, false))).not.toContain('pip i');
    });

    it('never returns secrets or header values, only their names', () => {
      const row = ciRow({
        secrets_enc: packSecretForStorage('{"API_TOKEN":"secret-value"}'),
        ci_headers_enc: packSecretForStorage(
          '{"Authorization":"Bearer header-value"}',
        ),
      });
      const config = toConfig(row, true);
      const text = JSON.stringify(config);

      expect(config.has_secrets).toBe(true);
      expect(config.secret_names).toEqual(['API_TOKEN']);
      expect(config.ci_header_names).toEqual(['Authorization']);
      expect(text).not.toContain('secret-value');
      expect(text).not.toContain('header-value');
      expect(text).not.toContain('encv1');
    });

    it('hides the command and variables from someone who cannot edit', () => {
      const row = {
        ...dockerRow(),
        command: 'TOKEN=abc make test',
        env: { TOKEN: 'abc' },
      };

      expect(toConfig(row, false)).toMatchObject({ command: null, env: null });
      expect(JSON.stringify(toConfig(row, false))).not.toContain('abc');
    });

    it('shows the command and variables to someone who can edit', () => {
      const row = {
        ...dockerRow(),
        command: 'make test',
        env: { BASE_URL: 'https://a.example.com' },
      };

      expect(toConfig(row, true)).toMatchObject({
        command: 'make test',
        env: { BASE_URL: 'https://a.example.com' },
      });
    });

    it('keeps a missing CI URL empty for a Docker setting', () => {
      expect(toConfig(dockerRow(), false).ci_url).toBeNull();
    });

    it('lists image keys but never the image addresses', () => {
      const images = service.images();

      expect(images.images).toEqual([{ key: 'playwright' }]);
      expect(JSON.stringify(images)).not.toContain('sha256');
    });

    it('adds language and version for a built-in image', () => {
      const saved = process.env.TM_RUNNER_ENABLED;

      process.env.TM_RUNNER_ENABLED = '1';

      const { images } = service.images();

      if (saved === undefined) delete process.env.TM_RUNNER_ENABLED;
      else process.env.TM_RUNNER_ENABLED = saved;

      expect(images).toContainEqual({
        key: 'node-24',
        language: 'Node.js',
        version: '24 (Jest, Vitest, Mocha)',
      });
    });

    it('lists CI jobs only unless asked for other kinds', async () => {
      const ciOnly = next({ data: [], error: null });

      await service.list(user, SPACE);

      expect(ciOnly.eq).toHaveBeenCalledWith('kind', 'ci_job');

      const runner = next({ data: [], error: null });

      await service.list(user, SPACE, false, 'docker');

      expect(runner.eq).toHaveBeenCalledWith('kind', 'docker');

      const all = next({ data: [], error: null });

      await service.list(user, SPACE, false, 'all');

      expect(all.eq).not.toHaveBeenCalledWith('kind', expect.anything());
    });

    it('finds a runner setting by id', async () => {
      const chain = next({ data: dockerRow(), error: null });

      await expect(service.get(user, SPACE, CONFIG)).resolves.toMatchObject({
        kind: 'docker',
        has_zip: false,
      });
      expect(chain.eq).not.toHaveBeenCalledWith('kind', expect.anything());
    });

    it('never returns the zip path', () => {
      const text = JSON.stringify(
        toConfig(dockerRow({ zip_path: 'automation/x/y.zip' }), true),
      );

      expect(text).not.toContain('automation/x');
    });
  });

  describe('create', () => {
    const ci: CreateTestAutomationConfigDto = {
      name: 'Nightly',
      kind: 'ci_job',
      ci_url: 'https://ci.example.com/job/a',
    };
    const docker: CreateTestAutomationConfigDto = {
      name: 'Browser tests',
      kind: 'docker',
      preset: 'playwright',
      image_key: 'playwright',
      source: 'zip',
      result_paths: ['results.xml', 'results.xml'],
    };

    it('saves a Docker setting with encrypted secrets and one copy of each path', async () => {
      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, {
        ...docker,
        secrets: { API_TOKEN: 'secret-value' },
      });

      const insert = firstArg(chain.insert);

      expect(insert.result_paths).toEqual(['results.xml']);
      expect(JSON.stringify(insert)).not.toContain('secret-value');
      expect(readSecretMap(insert.secrets_enc as string)).toEqual({
        API_TOKEN: 'secret-value',
      });
    });

    it('refuses a Docker field on a CI job and the other way round', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...ci, preset: 'pytest' })),
      ).resolves.toMatchObject({ field: 'preset' });
      await expect(
        refusal(
          service.create(user, SPACE, { ...docker, ci_url: 'https://a' }),
        ),
      ).resolves.toMatchObject({ field: 'ci_url' });
      expect(from).not.toHaveBeenCalled();
    });

    it.each<[keyof CreateTestAutomationConfigDto, string]>([
      ['preset', 'preset'],
      ['image_key', 'image_key'],
      ['source', 'source'],
      ['result_paths', 'result_paths'],
    ])('needs %s for a Docker setting', async (field, reported) => {
      const dto = { ...docker };

      delete dto[field];

      await expect(
        refusal(service.create(user, SPACE, dto)),
      ).resolves.toMatchObject({ field: reported });
    });

    it('refuses an image the server does not allow', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...docker, image_key: 'other' })),
      ).resolves.toMatchObject({ field: 'image_key' });
    });

    it('needs a repository for a git source', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...docker, source: 'git' })),
      ).resolves.toMatchObject({ field: 'repo_url' });
    });

    it('needs a command only for the custom preset', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...docker, preset: 'custom' })),
      ).resolves.toMatchObject({ field: 'command' });

      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, { ...docker, command: ' npm test ' });

      expect(firstArg(chain.insert).command).toBe('npm test');
    });

    it('stores blank commands as nothing, so the default stays', async () => {
      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, {
        ...docker,
        command: '  ',
        install_command: ' \n ',
      });

      expect(firstArg(chain.insert)).toMatchObject({
        command: null,
        install_command: null,
      });
    });

    it('stores an install command for any framework', async () => {
      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, {
        ...docker,
        install_command: ' npm i # local ',
      });

      expect(firstArg(chain.insert).install_command).toBe('npm i # local');
    });

    it('refuses an install command on a CI job', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...ci, install_command: 'x' })),
      ).resolves.toMatchObject({ field: 'install_command' });
    });

    it('refuses new secrets and clearing them in one request', async () => {
      await expect(
        refusal(
          service.create(user, SPACE, {
            ...docker,
            secrets: { A: 'x' },
            clear_secrets: true,
          }),
        ),
      ).resolves.toMatchObject({ field: 'secrets' });
    });

    it('refuses a name used as both a variable and a secret', async () => {
      await expect(
        refusal(
          service.create(user, SPACE, {
            ...docker,
            env: { API_TOKEN: 'plain' },
            secrets: { API_TOKEN: 'secret-value' },
          }),
        ),
      ).resolves.toMatchObject({ field: 'env' });
    });

    it('refuses secrets too long to store once encrypted', async () => {
      await expect(
        refusal(
          service.create(user, SPACE, {
            ...docker,
            secrets: Object.fromEntries(
              Array.from({ length: 4 }, (_, index) => [
                `S${index}`,
                'x'.repeat(4000),
              ]),
            ),
          }),
        ),
      ).resolves.toMatchObject({ field: 'secrets' });
    });

    it('saves a CI job when no kind is sent, as before', async () => {
      const chain = next({ data: ciRow(), error: null });

      await service.create(user, SPACE, {
        name: 'Nightly',
        ci_url: 'https://ci.example.com/job/a',
      });

      expect(firstArg(chain.insert)).toMatchObject({ kind: 'ci_job' });
      expect(firstArg(chain.insert)).not.toHaveProperty('preset');
    });

    it('accepts a typed public address for a new Git setting', async () => {
      connectedRepositories.mockResolvedValue([]);

      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, {
        ...docker,
        source: 'git',
        repo_url: 'https://g/b.git',
      });

      expect(firstArg(chain.insert)).toMatchObject({
        source: 'git',
        repo_url: 'https://g/b.git',
      });
      expect(publicCheck).toHaveBeenCalled();
    });

    it('refuses a GIT_TOKEN for a connected GitHub repository', async () => {
      connectedRepositories.mockResolvedValue([
        { web_url: 'https://g/b.git', provider: 'github' },
      ]);

      await expect(
        refusal(
          service.create(user, SPACE, {
            ...docker,
            source: 'git',
            repo_url: 'https://g/b.git',
            secrets: { GIT_TOKEN: 'x' },
          }),
        ),
      ).resolves.toMatchObject({ field: 'secrets' });
      expect(from).not.toHaveBeenCalled();
    });

    it('reports a bad branch on the runner field', async () => {
      await expect(
        refusal(
          service.create(user, SPACE, {
            ...docker,
            source: 'git',
            repo_url: 'https://g/a.git',
            repo_ref: 'a..b',
          }),
        ),
      ).resolves.toMatchObject({ field: 'repo_ref' });
    });
  });

  describe('update', () => {
    const updated = async (
      row: TestAutomationConfigRow,
      dto: Parameters<TestAutomationConfigsService['update']>[3],
    ) => {
      next({ data: row, error: null });

      const write = next({ data: row, error: null });

      await service.update(user, SPACE, CONFIG, dto);

      return firstArg(write.update);
    };

    it('drops the command when leaving Custom, even with nothing sent for it', async () => {
      const write = await updated(
        dockerRow({ preset: 'custom', command: 'make test' }),
        { preset: 'pytest' },
      );

      expect(write).toMatchObject({ preset: 'pytest', command: null });
    });

    it('drops the command when the form cleared it on leaving Custom', async () => {
      const write = await updated(
        dockerRow({ preset: 'custom', command: 'make test' }),
        { preset: 'pytest', command: '' },
      );

      expect(write.command).toBeNull();
    });

    it('keeps an override when another field changes', async () => {
      const write = await updated(
        dockerRow({ preset: 'pytest', command: 'pytest -q' }),
        { timeout_minutes: 10 },
      );

      expect(write.command).toBe('pytest -q');
    });

    it('clears an override when it is sent blank', async () => {
      const write = await updated(
        dockerRow({ preset: 'pytest', command: 'pytest -q' }),
        { command: '' },
      );

      expect(write.command).toBeNull();
    });

    it('still needs a command on a custom setting', async () => {
      next({
        data: dockerRow({ preset: 'custom', command: 'make test' }),
        error: null,
      });

      await expect(
        refusal(service.update(user, SPACE, CONFIG, { command: '  ' })),
      ).resolves.toMatchObject({ field: 'command' });
    });

    it('leaves the install command alone unless it is sent', async () => {
      const kept = await updated(dockerRow({ install_command: 'npm i' }), {
        timeout_minutes: 10,
      });
      const cleared = await updated(dockerRow({ install_command: 'npm i' }), {
        install_command: '',
      });

      expect(kept).not.toHaveProperty('install_command');
      expect(cleared.install_command).toBeNull();
    });

    it('refuses to change an archived setting', async () => {
      next({
        data: ciRow({ archived_at: '2026-11-01T00:00:00Z' }),
        error: null,
      });

      await expect(
        service.update(user, SPACE, CONFIG, { name: 'New' }),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
    });

    it('refuses when someone archives it at the same moment', async () => {
      next({ data: ciRow(), error: null });
      next({ data: null, error: null });

      await expect(
        service.update(user, SPACE, CONFIG, { name: 'New' }),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
    });

    it('does not check the stored URL again when only the name changes', async () => {
      next({ data: ciRow(), error: null });

      const write = next({ data: ciRow({ name: 'New' }), error: null });

      await service.update(user, SPACE, CONFIG, { name: 'New' });

      expect(publicCheck).not.toHaveBeenCalled();
      expect(write.is).toHaveBeenCalledWith('archived_at', null);
      expect(firstArg(write.update)).toMatchObject({
        name: 'New',
        ci_url: 'https://ci.example.com/job/a?token=hidden',
        updated_by: 'user-1',
      });
    });

    it('leaves saved secrets alone unless they are sent', async () => {
      next({ data: dockerRow({ secrets_enc: 'stored' }), error: null });

      const write = next({ data: dockerRow(), error: null });

      await service.update(user, SPACE, CONFIG, { name: 'New' });

      expect(firstArg(write.update)).not.toHaveProperty('secrets_enc');
    });

    it('refuses a variable named like a saved secret', async () => {
      next({
        data: dockerRow({
          secrets_enc: packSecretForStorage('{"API_TOKEN":"secret-value"}'),
        }),
        error: null,
      });

      await expect(
        refusal(
          service.update(user, SPACE, CONFIG, { env: { API_TOKEN: 'plain' } }),
        ),
      ).resolves.toMatchObject({ field: 'env' });
    });

    it('clears secrets on request and logs only that they changed', async () => {
      next({ data: dockerRow({ secrets_enc: 'stored' }), error: null });

      const write = next({ data: dockerRow(), error: null });
      const dto: UpdateTestAutomationConfigDto = { clear_secrets: true };

      await service.update(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update).secrets_enc).toBeNull();
      expect(auditMeta()).toContain('"secrets_changed":true');
    });

    it('never logs a new secret or header value', async () => {
      next({ data: dockerRow(), error: null });
      next({ data: dockerRow(), error: null });

      await service.update(user, SPACE, CONFIG, {
        secrets: { API_TOKEN: 'secret-value' },
      });

      expect(auditMeta()).not.toContain('secret-value');
      expect(auditMeta()).not.toContain('API_TOKEN');
    });

    it('drops the command when leaving the custom preset', async () => {
      next({
        data: dockerRow({ preset: 'custom', command: 'npm test' }),
        error: null,
      });

      const write = next({ data: dockerRow(), error: null });

      await service.update(user, SPACE, CONFIG, { preset: 'pytest' });

      expect(firstArg(write.update).command).toBeNull();
    });

    it('removes the old zip after a move from zip to git is saved', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });

      const write = next({
        data: dockerRow({ source: 'git', repo_url: 'https://g/a.git' }),
        error: null,
      });

      await service.update(user, SPACE, CONFIG, {
        source: 'git',
        repo_url: 'https://g/a.git',
      });

      expect(firstArg(write.update)).toMatchObject({
        zip_path: null,
        repo_url: 'https://g/a.git',
      });
      expect(storageFrom).toHaveBeenCalledWith(AUTOMATION_BUCKET);
      expect(remove).toHaveBeenCalledWith(['old.zip']);
    });

    it('keeps the old zip when that save fails', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });
      next({ data: null, error: { code: 'XX000', message: 'failed' } });

      await expect(
        service.update(user, SPACE, CONFIG, {
          source: 'git',
          repo_url: 'https://g/a.git',
        }),
      ).rejects.toBeDefined();
      expect(remove).not.toHaveBeenCalled();
    });

    it('keeps the zip when the source stays a zip', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });

      const write = next({ data: dockerRow(), error: null });

      await service.update(user, SPACE, CONFIG, { name: 'New' });

      expect(firstArg(write.update)).not.toHaveProperty('zip_path');
      expect(remove).not.toHaveBeenCalled();
    });

    it('refuses a runner field on a CI job and a CI field on a runner setting', async () => {
      next({ data: ciRow(), error: null });

      await expect(
        refusal(service.update(user, SPACE, CONFIG, { preset: 'pytest' })),
      ).resolves.toMatchObject({ field: 'preset' });

      next({ data: dockerRow(), error: null });

      await expect(
        refusal(
          service.update(user, SPACE, CONFIG, { ci_url: 'https://a.example' }),
        ),
      ).resolves.toMatchObject({ field: 'ci_url' });
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('refuses create_unmatched on a CI job', async () => {
      next({ data: ciRow(), error: null });

      await expect(
        refusal(
          service.update(user, SPACE, CONFIG, { create_unmatched: true }),
        ),
      ).resolves.toMatchObject({ field: 'create_unmatched' });
    });

    it('never changes the kind', async () => {
      const dto = { kind: 'docker' } as UpdateTestAutomationConfigDto;

      await expect(
        refusal(service.update(user, SPACE, CONFIG, dto)),
      ).resolves.toMatchObject({ field: 'kind' });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('returns an archived setting unchanged', async () => {
      next({
        data: ciRow({ archived_at: '2026-11-01T00:00:00Z' }),
        error: null,
      });

      await service.archive(user, SPACE, CONFIG);

      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('removes the zip copies of the waiting runs it cancels', async () => {
      next({ data: dockerRow({ zip_path: 'setting.zip' }), error: null });
      next({
        data: dockerRow({ archived_at: '2026-11-02T00:00:00Z' }),
        error: null,
      });

      const queued = next({
        data: [
          { run_zip_path: 'runs/a.zip' },
          { run_zip_path: null },
          { run_zip_path: 'runs/b.zip' },
        ],
        error: null,
      });

      next({ data: null, error: null });

      await service.archive(user, SPACE, CONFIG);

      expect(queued.select).toHaveBeenCalledWith('run_zip_path');
      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
      expect(remove).toHaveBeenCalledWith(['runs/b.zip']);
    });

    it('still asks running runs to stop when cancelling waiting ones fails', async () => {
      next({ data: dockerRow(), error: null });
      next({
        data: dockerRow({ archived_at: '2026-11-02T00:00:00Z' }),
        error: null,
      });
      next({ data: null, error: { message: 'write failed' } });

      const running = next({ data: null, error: null });

      await service.archive(user, SPACE, CONFIG);

      expect(remove).not.toHaveBeenCalled();
      expect(firstArg(running.update)).toHaveProperty('cancel_requested_at');
    });

    it('cancels waiting runs and asks running ones to stop', async () => {
      next({ data: dockerRow(), error: null });
      next({
        data: dockerRow({ archived_at: '2026-11-02T00:00:00Z' }),
        error: null,
      });

      const queued = next({ data: null, error: null });
      const running = next({ data: null, error: null });

      await service.archive(user, SPACE, CONFIG);

      expect(firstArg(queued.update)).toMatchObject({ status: 'CANCELLED' });
      expect(queued.eq).toHaveBeenCalledWith('status', 'QUEUED');
      expect(queued.eq).toHaveBeenCalledWith('config_id', CONFIG);
      expect(queued.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(firstArg(running.update)).toHaveProperty('cancel_requested_at');
      expect(running.eq).toHaveBeenCalledWith('status', 'RUNNING');
      expect(running.is).toHaveBeenCalledWith('cancel_requested_at', null);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('stops no runs when it archives a CI job', async () => {
      next({ data: ciRow(), error: null });
      next({
        data: ciRow({ archived_at: '2026-11-02T00:00:00Z' }),
        error: null,
      });

      await service.archive(user, SPACE, CONFIG);

      expect(from).toHaveBeenCalledTimes(2);
    });
  });

  describe('remove', () => {
    it('refuses while a runner run of the setting waits or runs', async () => {
      next({ data: dockerRow(), error: null });

      const runs = next({ count: 1, error: null });

      await expect(service.remove(user, SPACE, CONFIG)).rejects.toMatchObject({
        status: 409,
        response: { code: 'RUNS_IN_PROGRESS' },
      });
      expect(runs.in).toHaveBeenCalledWith('status', [
        'QUEUED',
        'RUNNING',
        'UPLOADING',
      ]);
      expect(runs.or).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('removes the zip and the files of the setting folder after the delete', async () => {
      const folder = `automation/${ORG}/${SPACE}/${CONFIG}`;

      next({ data: dockerRow({ zip_path: `${folder}/a.zip` }), error: null });
      next({ count: 0, error: null });

      const removed = next({ data: { id: CONFIG }, error: null });

      storageList.mockResolvedValue({
        data: [
          { id: '1', name: 'a.zip' },
          { id: '2', name: 'b.zip' },
          { id: null, name: 'runs' },
        ],
        error: null,
      });

      await service.remove(user, SPACE, CONFIG);

      expect(removed.eq).toHaveBeenCalledWith('kind', 'docker');
      expect(remove).toHaveBeenCalledWith([`${folder}/a.zip`]);
      expect(storageList).toHaveBeenCalledWith(folder, { limit: 1000 });
      expect(remove).toHaveBeenCalledWith([`${folder}/b.zip`]);
      expect(remove).toHaveBeenCalledTimes(2);
    });

    it('still deletes when the files cannot be removed', async () => {
      next({ data: dockerRow({ zip_path: 'a.zip' }), error: null });
      next({ count: 0, error: null });
      next({ data: { id: CONFIG }, error: null });
      remove.mockResolvedValue({ error: { message: 'storage down' } });
      storageList.mockResolvedValue({ data: null, error: { message: 'down' } });

      await expect(
        service.remove(user, SPACE, CONFIG),
      ).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_config',
        CONFIG,
        'delete',
        { name: 'Nightly' },
      );
    });

    it('keeps the files when the delete finds nothing', async () => {
      next({ data: dockerRow({ zip_path: 'a.zip' }), error: null });
      next({ count: 0, error: null });
      next({ data: null, error: null });

      await expect(service.remove(user, SPACE, CONFIG)).rejects.toMatchObject({
        status: 404,
      });
      expect(remove).not.toHaveBeenCalled();
    });

    it('touches no storage for a CI job', async () => {
      next({ data: ciRow(), error: null });
      next({ count: 0, error: null });
      next({ data: { id: CONFIG }, error: null });

      await service.remove(user, SPACE, CONFIG);

      expect(storageFrom).not.toHaveBeenCalled();
    });
  });

  describe('uploadZip', () => {
    const file = (name = 'tests.zip', size = 10) =>
      ({
        originalname: name,
        size,
        buffer: Buffer.from('zip'),
      }) as Express.Multer.File;

    it('needs a Docker setting whose source is a zip', async () => {
      next({ data: ciRow(), error: null });

      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file())),
      ).resolves.toMatchObject({ field: 'source' });
      expect(upload).not.toHaveBeenCalled();
    });

    it('refuses an archived setting', async () => {
      next({
        data: dockerRow({ archived_at: '2026-11-01T00:00:00Z' }),
        error: null,
      });

      await expect(
        service.uploadZip(user, SPACE, CONFIG, file()),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
    });

    it('refuses another file type and an oversized file', async () => {
      next({ data: dockerRow(), error: null });
      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file('tests.tar'))),
      ).resolves.toMatchObject({ field: 'file' });

      next({ data: dockerRow(), error: null });
      await expect(
        refusal(
          service.uploadZip(
            user,
            SPACE,
            CONFIG,
            file('tests.zip', 50 * 1024 * 1024 + 1),
          ),
        ),
      ).resolves.toMatchObject({ field: 'file' });
      expect(upload).not.toHaveBeenCalled();
    });

    it('reports why a zip was refused and stores nothing', async () => {
      next({ data: dockerRow(), error: null });
      zipCheck.mockResolvedValue('UNSAFE_PATH');

      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file())),
      ).resolves.toMatchObject({
        code: 'ZIP_REJECTED',
        reason: 'UNSAFE_PATH',
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('sends the reason where the error filter forwards it', async () => {
      next({ data: dockerRow(), error: null });
      zipCheck.mockResolvedValue('UNSAFE_PATH');

      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file())),
      ).resolves.toMatchObject({
        data: { field: 'file', reason: 'UNSAFE_PATH' },
      });
    });

    it('stores the new file, saves its path, then removes the old one', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });

      const write = next({ data: dockerRow({ zip_path: 'new' }), error: null });
      const config = await service.uploadZip(user, SPACE, CONFIG, file());
      const path = (upload.mock.calls as unknown[][])[0]?.[0] as string;

      expect(path).toMatch(
        new RegExp(`^automation/${ORG}/${SPACE}/${CONFIG}/[0-9a-f-]+\\.zip$`),
      );
      expect(firstArg(write.update)).toMatchObject({ zip_path: path });
      expect(remove).toHaveBeenCalledWith(['old.zip']);
      expect(config.has_zip).toBe(true);
    });

    it('refuses a zip that holds no files and stores nothing', async () => {
      next({ data: dockerRow(), error: null });
      (listZipFiles as jest.Mock).mockResolvedValueOnce({
        names: [],
        files: [],
      });

      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file())),
      ).resolves.toMatchObject({ code: 'ZIP_REJECTED', reason: 'EMPTY' });
      expect(upload).not.toHaveBeenCalled();
    });

    it('answers with an error and keeps the old file when storing fails', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });
      upload.mockResolvedValue({ error: { message: 'storage down' } });

      await expect(
        refusal(service.uploadZip(user, SPACE, CONFIG, file())),
      ).resolves.toMatchObject({ code: 'UPLOAD_FAILED' });
      expect(remove).not.toHaveBeenCalled();
    });

    it('removes the new file when its path cannot be saved', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });
      next({ data: null, error: null });
      next({
        data: dockerRow({ archived_at: '2026-11-01T00:00:00Z' }),
        error: null,
      });

      await expect(
        service.uploadZip(user, SPACE, CONFIG, file()),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });

      const path = (upload.mock.calls as unknown[][])[0]?.[0] as string;

      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith([path]);
    });
  });

  describe('uploadZip update condition', () => {
    const file = () =>
      ({
        originalname: 'tests.zip',
        size: 10,
        buffer: Buffer.from('zip'),
      }) as Express.Multer.File;

    it('matches a first upload with is null, because eq null matches nothing', async () => {
      next({ data: dockerRow(), error: null });

      const write = next({ data: dockerRow({ zip_path: 'new' }), error: null });

      await service.uploadZip(user, SPACE, CONFIG, file());

      expect(write.is).toHaveBeenCalledWith('zip_path', null);
      expect(write.eq).not.toHaveBeenCalledWith('zip_path', expect.anything());
    });

    it('matches a later upload on the path it read', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });

      const write = next({ data: dockerRow({ zip_path: 'new' }), error: null });

      await service.uploadZip(user, SPACE, CONFIG, file());

      expect(write.eq).toHaveBeenCalledWith('zip_path', 'old.zip');
    });

    it('answers FILES_CHANGED when someone else got there first', async () => {
      next({ data: dockerRow({ zip_path: 'old.zip' }), error: null });
      next({ data: null, error: null });
      next({ data: dockerRow({ zip_path: 'other.zip' }), error: null });

      await expect(
        service.uploadZip(user, SPACE, CONFIG, file()),
      ).rejects.toMatchObject({ response: { code: 'FILES_CHANGED' } });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalledWith(['other.zip']);
    });
  });

  describe('test files', () => {
    const VERSION = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const FOLDER = `automation/${ORG}/${SPACE}/${CONFIG}`;
    const ZIP = `${FOLDER}/${VERSION}.zip`;
    const listZip = listZipFiles as jest.Mock;
    const readZip = readZipFile as jest.Mock;
    const rebuild = rebuildZip as jest.Mock;

    const zipped = (...paths: string[]) => ({
      names: paths,
      files: paths.map((path) => ({ path, size: 1 })),
    });

    const save = (path: string, version: string | null = VERSION) =>
      service.saveFile(user, SPACE, CONFIG, { path, content: 'x', version });

    const codeOf = (run: Promise<unknown>) =>
      run.then(
        () => null,
        (error: unknown) =>
          (
            (error as { getResponse: () => { code?: string } }).getResponse() ??
            {}
          ).code,
      );

    beforeEach(() => {
      listZip.mockReset();
      listZip.mockResolvedValue(zipped('a.txt', 'b.txt'));
      readZip.mockReset();
      rebuild.mockReset();
      rebuild.mockResolvedValue(Buffer.from('rebuilt'));
    });

    describe('names in a stored zip', () => {
      it('reads the names of that zip', async () => {
        listZip.mockResolvedValue(zipped('a.spec.js', 'b.spec.js'));

        await expect(service.zipFilePaths('some.zip')).resolves.toEqual([
          'a.spec.js',
          'b.spec.js',
        ]);
        expect(download).toHaveBeenCalledWith('some.zip');
      });

      it('answers ZIP_COPY_FAILED when the zip cannot be read', async () => {
        download.mockResolvedValue({ data: null, error: { message: 'gone' } });

        await expect(codeOf(service.zipFilePaths('some.zip'))).resolves.toBe(
          'ZIP_COPY_FAILED',
        );
      });

      it('answers ZIP_NOT_EDITABLE for a zip that cannot be listed', async () => {
        listZip.mockRejectedValue(new ZipFileError('NOT_EDITABLE'));

        await expect(codeOf(service.zipFilePaths('some.zip'))).resolves.toBe(
          'ZIP_NOT_EDITABLE',
        );
      });
    });

    describe('reading', () => {
      it('looks the setting up in this organization and space', async () => {
        const row = next({ data: null, error: null });

        await expect(
          service.listFiles(user, SPACE, CONFIG),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
        expect(row.eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(row.eq).toHaveBeenCalledWith('space_id', SPACE);
        expect(download).not.toHaveBeenCalled();
      });

      it('returns names, sizes and only the UUID as the version', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        const answer = await service.listFiles(user, SPACE, CONFIG);

        expect(answer).toEqual({
          version: VERSION,
          files: [
            { path: 'a.txt', size: 1 },
            { path: 'b.txt', size: 1 },
          ],
        });
        expect(JSON.stringify(answer)).not.toContain('automation/');
        expect(download).toHaveBeenCalledWith(ZIP);
      });

      it('lists nothing for a setting with no zip, without touching storage', async () => {
        next({ data: dockerRow(), error: null });

        await expect(service.listFiles(user, SPACE, CONFIG)).resolves.toEqual({
          version: null,
          files: [],
        });
        expect(download).not.toHaveBeenCalled();
      });

      it.each([
        ['a Git setting', () => dockerRow({ source: 'git' })],
        ['a CI setting', () => ciRow()],
      ])('refuses %s', async (_, row) => {
        next({ data: row(), error: null });

        await expect(
          refusal(service.listFiles(user, SPACE, CONFIG)),
        ).resolves.toMatchObject({ field: 'source' });
      });

      it('still lets an archived setting be read', async () => {
        next({
          data: dockerRow({
            zip_path: ZIP,
            archived_at: '2026-11-01T00:00:00Z',
          }),
          error: null,
        });
        readZip.mockResolvedValue({ content: 'x', not_editable: null });

        await expect(
          service.readFile(user, SPACE, CONFIG, 'a.txt'),
        ).resolves.toEqual({
          path: 'a.txt',
          version: VERSION,
          content: 'x',
          not_editable: null,
        });
      });

      it('says when a file cannot be edited', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        readZip.mockResolvedValue({ content: null, not_editable: 'binary' });

        await expect(
          service.readFile(user, SPACE, CONFIG, 'a.bin'),
        ).resolves.toMatchObject({ content: null, not_editable: 'binary' });
      });

      it('answers 404 for a missing file or no zip', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        readZip.mockResolvedValue(null);
        await expect(
          service.readFile(user, SPACE, CONFIG, 'nope'),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });

        next({ data: dockerRow(), error: null });
        await expect(
          service.readFile(user, SPACE, CONFIG, 'a.txt'),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
      });

      it('answers ZIP_NOT_EDITABLE for an encrypted file', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        readZip.mockRejectedValue(new ZipFileError('NOT_EDITABLE'));

        await expect(
          codeOf(service.readFile(user, SPACE, CONFIG, 'a.txt')),
        ).resolves.toBe('ZIP_NOT_EDITABLE');
      });

      it('answers FILES_CHANGED when the zip was replaced while reading', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        download.mockResolvedValue({ data: null, error: { message: 'gone' } });
        next({
          data: dockerRow({ zip_path: `${FOLDER}/${OTHER}.zip` }),
          error: null,
        });

        await expect(
          codeOf(service.listFiles(user, SPACE, CONFIG)),
        ).resolves.toBe('FILES_CHANGED');
      });

      it('answers ZIP_COPY_FAILED when storage fails and nothing changed', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        download.mockResolvedValue({ data: null, error: { message: 'down' } });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(
          codeOf(service.listFiles(user, SPACE, CONFIG)),
        ).resolves.toBe('ZIP_COPY_FAILED');
      });
    });

    describe('saving', () => {
      it('stores a new zip, swaps on the version read, then removes the old one', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        const write = next({
          data: dockerRow({ zip_path: `${FOLDER}/${OTHER}.zip` }),
          error: null,
        });

        listZip
          .mockResolvedValueOnce(zipped('a.txt'))
          .mockResolvedValueOnce(zipped('a.txt'));

        const answer = await save('a.txt');
        const path = (upload.mock.calls as unknown[][])[0]?.[0] as string;

        expect(path).toMatch(new RegExp(`^${FOLDER}/[0-9a-f-]{36}\\.zip$`));
        expect(rebuild).toHaveBeenCalledWith(
          expect.any(Buffer),
          'a.txt',
          Buffer.from('x'),
        );
        expect(zipCheck).toHaveBeenCalledWith(Buffer.from('rebuilt'));
        expect(firstArg(write.update)).toMatchObject({ zip_path: path });
        expect(write.eq).toHaveBeenCalledWith('zip_path', ZIP);
        expect(write.is).toHaveBeenCalledWith('archived_at', null);
        expect(remove).toHaveBeenCalledWith([ZIP]);
        expect(answer.version).toBe(OTHER);
        expect(answer.config.has_zip).toBe(true);
        expect(JSON.stringify(answer)).not.toContain('automation/');
      });

      it('writes a first file with is null and no version', async () => {
        next({ data: dockerRow(), error: null });

        const write = next({
          data: dockerRow({ zip_path: `${FOLDER}/${OTHER}.zip` }),
          error: null,
        });

        listZip.mockResolvedValue(zipped('a.txt'));

        await save('a.txt', null);

        expect(download).not.toHaveBeenCalled();
        expect(rebuild).toHaveBeenCalledWith(null, 'a.txt', Buffer.from('x'));
        expect(write.is).toHaveBeenCalledWith('zip_path', null);
        expect(remove).not.toHaveBeenCalled();
      });

      it('audits the path and never the content', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await service.saveFile(user, SPACE, CONFIG, {
          path: 'a.txt',
          content: 'super-secret-code',
          version: VERSION,
        });

        expect(auditMeta()).toContain('a.txt');
        expect(auditMeta()).not.toContain('super-secret-code');
      });

      it('answers FILES_CHANGED and writes nothing when the version is old', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(codeOf(save('a.txt', OTHER))).resolves.toBe(
          'FILES_CHANGED',
        );
        expect(download).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
      });

      it('answers FILES_CHANGED when a first file finds a zip already there', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(codeOf(save('a.txt', null))).resolves.toBe(
          'FILES_CHANGED',
        );
      });

      it('tells a lost race from an archived setting by reading again', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: null, error: null });
        next({
          data: dockerRow({ zip_path: `${FOLDER}/${OTHER}.zip` }),
          error: null,
        });

        await expect(codeOf(save('a.txt'))).resolves.toBe('FILES_CHANGED');

        const newPath = (upload.mock.calls as unknown[][])[0]?.[0] as string;

        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith([newPath]);

        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: null, error: null });
        next({
          data: dockerRow({
            zip_path: ZIP,
            archived_at: '2026-11-01T00:00:00Z',
          }),
          error: null,
        });

        await expect(codeOf(save('a.txt'))).resolves.toBe('ARCHIVED');
      });

      it('leaves an archived setting and an archived space read-only', async () => {
        next({
          data: dockerRow({
            zip_path: ZIP,
            archived_at: '2026-11-01T00:00:00Z',
          }),
          error: null,
        });

        await expect(codeOf(save('a.txt'))).resolves.toBe('ARCHIVED');
        expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
          write: true,
        });
        expect(upload).not.toHaveBeenCalled();
      });

      it('refuses an unsafe new path', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(refusal(save('../evil'))).resolves.toMatchObject({
          field: 'path',
        });
        expect(rebuild).not.toHaveBeenCalled();
      });

      it('refuses a new name that clashes with what is in the zip', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(refusal(save('A.TXT'))).resolves.toMatchObject({
          field: 'path',
        });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        await expect(refusal(save('a.txt/b'))).resolves.toMatchObject({
          field: 'path',
        });
        expect(upload).not.toHaveBeenCalled();
      });

      it('lets an existing file with spaces be replaced, even beside a clash', async () => {
        listZip.mockResolvedValue(zipped('my file.txt', 'MY FILE.txt'));
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(save('my file.txt')).resolves.toBeDefined();
      });

      it('refuses text over 1 MB and a NUL byte before reading anything', async () => {
        await expect(
          refusal(
            service.saveFile(user, SPACE, CONFIG, {
              path: 'a.txt',
              content: 'x'.repeat(1024 * 1024 + 1),
              version: VERSION,
            }),
          ),
        ).resolves.toMatchObject({ field: 'content' });
        await expect(
          refusal(
            service.saveFile(user, SPACE, CONFIG, {
              path: 'a.txt',
              content: 'a\0b',
              version: VERSION,
            }),
          ),
        ).resolves.toMatchObject({ field: 'content' });
        expect(from).not.toHaveBeenCalled();
      });

      it('answers ZIP_NOT_EDITABLE when another file cannot be packed again', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        rebuild.mockRejectedValue(new ZipFileError('NOT_EDITABLE'));

        await expect(codeOf(save('a.txt'))).resolves.toBe('ZIP_NOT_EDITABLE');
        expect(upload).not.toHaveBeenCalled();
      });

      it('refuses a new zip over 50 MB and one that fails the zip check', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        rebuild.mockRejectedValueOnce(new ZipFileError('TOO_LARGE'));
        await expect(refusal(save('a.txt'))).resolves.toMatchObject({
          field: 'file',
        });

        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        zipCheck.mockResolvedValue('TOO_MANY_ENTRIES');
        await expect(refusal(save('a.txt'))).resolves.toMatchObject({
          code: 'ZIP_REJECTED',
          reason: 'TOO_MANY_ENTRIES',
        });
        expect(upload).not.toHaveBeenCalled();
      });

      it('answers UPLOAD_FAILED and keeps the setting as it is when storing fails', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        upload.mockResolvedValue({ error: { message: 'storage down' } });

        await expect(codeOf(save('a.txt'))).resolves.toBe('UPLOAD_FAILED');
        expect(remove).not.toHaveBeenCalled();
      });
    });

    describe('uploading one file', () => {
      it('stores the file bytes under the path sent', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        const bytes = Buffer.from([0, 1, 2]);

        await service.uploadFile(
          user,
          SPACE,
          CONFIG,
          { path: 'data.bin', version: VERSION },
          { buffer: bytes } as Express.Multer.File,
        );

        expect(rebuild).toHaveBeenCalledWith(
          expect.any(Buffer),
          'data.bin',
          bytes,
        );
      });
    });

    describe('deleting', () => {
      it('keeps the other files', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await service.deleteFile(user, SPACE, CONFIG, {
          path: 'a.txt',
          version: VERSION,
        });

        expect(rebuild).toHaveBeenCalledWith(expect.any(Buffer), 'a.txt', null);
      });

      it('clears the path instead of storing an empty zip when the last file goes', async () => {
        listZip.mockResolvedValue({
          names: ['folder/', 'a.txt'],
          files: [{ path: 'a.txt', size: 1 }],
        });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        const write = next({ data: dockerRow(), error: null });
        const answer = await service.deleteFile(user, SPACE, CONFIG, {
          path: 'a.txt',
          version: VERSION,
        });

        expect(firstArg(write.update)).toMatchObject({ zip_path: null });
        expect(write.eq).toHaveBeenCalledWith('zip_path', ZIP);
        expect(rebuild).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith([ZIP]);
        expect(answer).toMatchObject({ version: null, files: [] });
        expect(answer.config.has_zip).toBe(false);
      });

      it('answers 404 for a file that is not there', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(
          service.deleteFile(user, SPACE, CONFIG, {
            path: 'nope',
            version: VERSION,
          }),
        ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
      });

      it('can delete an existing file whose name would be refused as new', async () => {
        listZip.mockResolvedValue(zipped('my file.txt', 'b.txt'));
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(
          service.deleteFile(user, SPACE, CONFIG, {
            path: 'my file.txt',
            version: VERSION,
          }),
        ).resolves.toBeDefined();
      });
    });

    describe('deleting a file test cases link to', () => {
      const deleted = (
        workDir: string | null,
        path: string,
        cases?: Resolved,
      ) => {
        const row = dockerRow({ zip_path: ZIP, work_dir: workDir });

        listZip.mockResolvedValue(zipped(path, 'other.txt'));
        next({ data: row, error: null });
        next({ data: row, error: null });

        const lookup = cases ? next(cases) : null;

        return {
          lookup,
          answer: service.deleteFile(user, SPACE, CONFIG, {
            path,
            version: VERSION,
          }),
        };
      };

      it('names them by ticket key, from the tests folder, and still deletes the file', async () => {
        const { lookup, answer } = deleted('e2e', 'e2e/a.spec.ts', {
          data: [{ task: { key: 'P-T9' } }, { task: { key: 'P-T2' } }],
          error: null,
        });

        expect((await answer).linked_case_keys).toEqual(['P-T2', 'P-T9']);
        expect(rebuild).toHaveBeenCalled();
        expect(lookup?.eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(lookup?.eq).toHaveBeenCalledWith('space_id', SPACE);
        expect(lookup?.eq).toHaveBeenCalledWith(
          'automation_spec_path',
          'a.spec.ts',
        );
      });

      it('adds nothing when no case links to it', async () => {
        const { answer } = deleted(null, 'a.spec.ts', {
          data: [],
          error: null,
        });

        expect(await answer).not.toHaveProperty('linked_case_keys');
      });

      it('does not look for a file outside the tests folder', async () => {
        const { answer } = deleted('e2e', 'docs/a.spec.ts');

        expect(await answer).not.toHaveProperty('linked_case_keys');
        expect(from).toHaveBeenCalledTimes(2);
      });

      it('still deletes the file when the read fails', async () => {
        const { answer } = deleted(null, 'a.spec.ts', {
          data: null,
          error: { message: 'down' },
        });

        await expect(answer).resolves.not.toHaveProperty('linked_case_keys');
        expect(rebuild).toHaveBeenCalled();
      });
    });

    describe('deleting several files', () => {
      const removeMany = (paths: string[], version: string | null = VERSION) =>
        service.deleteFiles(user, SPACE, CONFIG, { paths, version });

      it('removes them in one rebuild and one store', async () => {
        listZip
          .mockResolvedValueOnce(zipped('a.txt', 'b.txt', 'c.txt'))
          .mockResolvedValueOnce(zipped('c.txt'));
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({
          data: dockerRow({ zip_path: `${FOLDER}/${OTHER}.zip` }),
          error: null,
        });

        const answer = await removeMany(['a.txt', 'b.txt']);

        expect(rebuild).toHaveBeenCalledTimes(1);
        expect(rebuild).toHaveBeenCalledWith(
          expect.any(Buffer),
          'a.txt',
          null,
          ['b.txt'],
        );
        expect(upload).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith([ZIP]);
        expect(answer).toMatchObject({
          version: OTHER,
          files: [{ path: 'c.txt', size: 1 }],
        });
        expect(answer).not.toHaveProperty('linked_case_keys');
      });

      it('merges repeated paths', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await removeMany(['a.txt', 'a.txt']);

        expect(rebuild).toHaveBeenCalledWith(
          expect.any(Buffer),
          'a.txt',
          null,
          [],
        );
        expect((log.mock.calls as unknown[][])[0]?.[4]).toEqual({
          file_action: 'deleted',
          paths: ['a.txt'],
        });
      });

      it('names every missing path and changes nothing', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(removeMany(['a.txt', 'x', 'y'])).rejects.toMatchObject({
          response: {
            code: 'NOT_FOUND',
            message: 'Not in the test project: x, y',
            data: { paths: ['x', 'y'] },
          },
        });
        expect(rebuild).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(from).toHaveBeenCalledTimes(1);
        expect(log).not.toHaveBeenCalled();
      });

      it('answers FILES_CHANGED and reads nothing when the version is old', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        await expect(codeOf(removeMany(['a.txt'], OTHER))).resolves.toBe(
          'FILES_CHANGED',
        );
        expect(download).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
      });

      it('clears the path like the last-file delete when every file goes', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });

        const write = next({ data: dockerRow(), error: null });
        const answer = await removeMany(['b.txt', 'a.txt']);

        expect(firstArg(write.update)).toMatchObject({ zip_path: null });
        expect(rebuild).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith([ZIP]);
        expect(answer).toMatchObject({ version: null, files: [] });
        expect(answer.config.has_zip).toBe(false);
      });

      it('returns the sorted keys of cases linked to any of the files', async () => {
        const row = dockerRow({ zip_path: ZIP, work_dir: 'e2e' });

        listZip.mockResolvedValue(
          zipped('e2e/a.spec.ts', 'e2e/b.spec.ts', 'other.txt'),
        );
        next({ data: row, error: null });
        next({ data: row, error: null });
        next({
          data: [{ task: { key: 'P-T9' } }, { task: { key: 'P-T2' } }],
          error: null,
        });
        next({
          data: [{ task: { key: 'P-T2' } }, { task: { key: 'P-T5' } }],
          error: null,
        });

        const answer = await removeMany(['e2e/a.spec.ts', 'e2e/b.spec.ts']);

        expect(answer.linked_case_keys).toEqual(['P-T2', 'P-T5', 'P-T9']);
      });

      it('writes one audit entry naming every path', async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        listZip.mockResolvedValue(zipped('a.txt', 'b.txt', 'c.txt'));

        await removeMany(['a.txt', 'c.txt']);

        expect(log).toHaveBeenCalledTimes(1);
        expect((log.mock.calls as unknown[][])[0]?.[4]).toEqual({
          file_action: 'deleted',
          paths: ['a.txt', 'c.txt'],
        });
      });

      describe('request body', () => {
        const errorsOf = async (plain: Record<string, unknown>) =>
          (
            await validate(
              plainToInstance(DeleteTestAutomationFilesDto, plain),
              {
                whitelist: true,
                forbidNonWhitelisted: true,
              },
            )
          ).map((error) => error.property);

        it('accepts paths with or without a version', async () => {
          await expect(errorsOf({ paths: ['a.txt'] })).resolves.toEqual([]);
          await expect(
            errorsOf({ paths: ['a.txt'], version: null }),
          ).resolves.toEqual([]);
          await expect(
            errorsOf({ paths: ['a.txt'], version: VERSION }),
          ).resolves.toEqual([]);
        });

        it.each([
          ['no paths', { paths: [] }, 'paths'],
          [
            'more than 200 paths',
            { paths: Array.from({ length: 201 }, (_, i) => `f${i}`) },
            'paths',
          ],
          ['a path that is not text', { paths: ['a.txt', 1] }, 'paths'],
          ['an empty path', { paths: [''] }, 'paths'],
          ['paths that are not a list', { paths: 'a.txt' }, 'paths'],
          [
            'a version that is not a UUID',
            { paths: ['a'], version: 'x' },
            'version',
          ],
          ['another key', { paths: ['a.txt'], path: 'a.txt' }, 'path'],
        ])('refuses %s', async (_name, plain, property) => {
          await expect(errorsOf(plain)).resolves.toEqual([property]);
        });
      });
    });

    describe('removing forgotten zips', () => {
      const hoursAgo = (hours: number) =>
        new Date(Date.now() - hours * 3600_000).toISOString();

      const writeOnce = async () => {
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        next({ data: dockerRow({ zip_path: ZIP }), error: null });
        await save('a.txt');
      };

      it('removes old top-level zips, and leaves the runs folder and fresh zips alone', async () => {
        storageList.mockResolvedValue({
          data: [
            { id: null, name: 'runs', created_at: null },
            { id: '1', name: 'forgotten.zip', created_at: hoursAgo(2) },
            { id: '2', name: 'in-flight.zip', created_at: hoursAgo(0) },
            { id: '3', name: 'notes.txt', created_at: hoursAgo(2) },
          ],
          error: null,
        });

        await writeOnce();

        expect(storageList).toHaveBeenCalledWith(FOLDER, { limit: 1000 });
        expect(remove).toHaveBeenCalledWith([`${FOLDER}/forgotten.zip`]);
        expect(remove).not.toHaveBeenCalledWith([`${FOLDER}/in-flight.zip`]);
        expect(remove).not.toHaveBeenCalledWith([`${FOLDER}/runs`]);
        expect(remove).not.toHaveBeenCalledWith([`${FOLDER}/notes.txt`]);
      });

      it('never fails the change when the folder cannot be listed', async () => {
        storageList.mockResolvedValue({
          data: null,
          error: { message: 'down' },
        });

        await expect(writeOnce()).resolves.toBeUndefined();
      });
    });
  });

  describe('a setting that detects its framework', () => {
    const auto: CreateTestAutomationConfigDto = {
      name: 'Any tests',
      kind: 'docker',
      preset: 'auto',
      source: 'zip',
    };
    const listZip = listZipFiles as jest.Mock;
    const readZip = readZipFile as jest.Mock;

    const updated = async (
      row: TestAutomationConfigRow,
      dto: UpdateTestAutomationConfigDto,
    ) => {
      next({ data: row, error: null });

      const write = next({ data: row, error: null });

      await service.update(user, SPACE, CONFIG, dto);

      return firstArg(write.update);
    };

    it('stores the auto image and the fixed result file, whatever was sent', async () => {
      const chain = next({ data: dockerRow(), error: null });

      await service.create(user, SPACE, {
        ...auto,
        image_key: 'playwright',
        result_paths: ['other.xml'],
      });

      expect(firstArg(chain.insert)).toMatchObject({
        preset: 'auto',
        image_key: 'auto',
        result_paths: ['.xisuite-results/results.xml'],
        command: null,
      });
    });

    it('refuses its own test or install command', async () => {
      await expect(
        refusal(service.create(user, SPACE, { ...auto, command: 'npm test' })),
      ).resolves.toMatchObject({ field: 'command' });
      await expect(
        refusal(
          service.create(user, SPACE, { ...auto, install_command: 'npm i' }),
        ),
      ).resolves.toMatchObject({ field: 'install_command' });
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses the auto image with a named framework', async () => {
      await expect(
        refusal(
          service.create(user, SPACE, {
            name: 'Browser tests',
            kind: 'docker',
            preset: 'playwright',
            image_key: 'auto',
            source: 'zip',
            result_paths: ['r.xml'],
          }),
        ),
      ).resolves.toMatchObject({
        field: 'image_key',
        message: 'Choose an image for this framework',
      });
    });

    it('needs an image when leaving auto, and keeps the result path', async () => {
      const row = dockerRow({
        preset: 'auto',
        image_key: 'auto',
        result_paths: ['.xisuite-results/results.xml'],
      });

      next({ data: row, error: null });

      await expect(
        refusal(service.update(user, SPACE, CONFIG, { preset: 'jest' })),
      ).resolves.toMatchObject({ field: 'image_key' });

      const write = await updated(row, {
        preset: 'playwright',
        image_key: 'playwright',
      });

      expect(write).toMatchObject({
        preset: 'playwright',
        image_key: 'playwright',
        result_paths: ['.xisuite-results/results.xml'],
      });
    });

    it('drops an override and an install command when moving to auto', async () => {
      const write = await updated(
        dockerRow({ command: 'npx playwright test', install_command: 'npm i' }),
        { preset: 'auto' },
      );

      expect(write).toMatchObject({
        image_key: 'auto',
        command: null,
        install_command: null,
      });
    });

    it('answers AUTO_NOT_AVAILABLE when the database does not allow auto yet', async () => {
      next({
        data: null,
        error: {
          code: '23514',
          message:
            'new row for relation "test_automation_configs" violates check constraint "test_automation_configs_preset_check"',
        },
      });

      await expect(
        refusal(service.create(user, SPACE, auto)),
      ).resolves.toMatchObject({ code: 'AUTO_NOT_AVAILABLE' });

      next({
        data: null,
        error: { code: '23514', message: 'violates check constraint "x"' },
      });

      await expect(
        refusal(service.create(user, SPACE, auto)),
      ).resolves.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    describe('the framework route', () => {
      const answer = (row: TestAutomationConfigRow) => {
        next({ data: row, error: null });

        return service.framework(user, SPACE, CONFIG);
      };
      const codeOf = (run: Promise<unknown>) =>
        run.then(
          () => null,
          (error: unknown) =>
            (error as { getResponse: () => { code?: string } }).getResponse()
              .code,
        );

      beforeEach(() => {
        listZip.mockReset();
        readZip.mockReset();
      });

      it('detects from the stored zip, reading package.json in the tests folder', async () => {
        listZip.mockResolvedValue({
          names: [],
          files: [
            { path: 'web/package.json', size: 10 },
            { path: 'web/a.test.js', size: 1 },
          ],
        });
        readZip.mockResolvedValue({
          content: JSON.stringify({ devDependencies: { mocha: '12' } }),
          not_editable: null,
        });

        await expect(
          answer(dockerRow({ zip_path: 'a.zip', work_dir: 'web' })),
        ).resolves.toEqual({
          preset: 'mocha',
          image_key: 'node-24',
          reason: 'package.json devDependencies',
        });
        expect(download).toHaveBeenCalledWith('a.zip');
        expect((readZip.mock.calls as unknown[][])[0][1]).toBe(
          'web/package.json',
        );
        expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      });

      it('answers preset null when nothing is found, and ignores an unreadable package.json', async () => {
        listZip.mockResolvedValue({
          names: [],
          files: [{ path: 'package.json', size: 10 }],
        });
        readZip.mockRejectedValue(new ZipFileError('NOT_EDITABLE'));

        await expect(answer(dockerRow({ zip_path: 'a.zip' }))).resolves.toEqual(
          { preset: null },
        );
      });

      it('answers DETECTED_AT_RUN for a Git setting and ZIP_MISSING without a zip', async () => {
        await expect(
          codeOf(
            answer(dockerRow({ source: 'git', repo_url: 'https://g/a.git' })),
          ),
        ).resolves.toBe('DETECTED_AT_RUN');
        await expect(codeOf(answer(dockerRow()))).resolves.toBe('ZIP_MISSING');
        await expect(codeOf(answer(ciRow()))).resolves.toBe(
          'NOT_A_RUNNER_SETTING',
        );
        expect(download).not.toHaveBeenCalled();
      });
    });
  });
});
