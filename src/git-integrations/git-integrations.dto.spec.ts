/**
 * @fileoverview Validation tests for UpdateGitBranchSettingsDto / BRANCH_PREFIX_PATTERN (ticket 3).
 * @module src/git-integrations/git-integrations.dto.spec
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  BRANCH_PREFIX_PATTERN,
  ConnectGithubInstallationDto,
  UpdateGitBranchSettingsDto,
} from './git-integrations.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(UpdateGitBranchSettingsDto, body))).map(
    (error) => error.property,
  );

describe('UpdateGitBranchSettingsDto', () => {
  it.each(['', 'feature/', '{username}/', 'team.a/feat_x-', 'x'.repeat(30)])(
    'accepts prefix %p',
    async (prefix) => {
      expect(await errorsFor({ prefix, keyCase: 'upper' })).toEqual([]);
    },
  );

  it.each([
    '../x',
    'a//b',
    '/feat',
    '-x',
    'has space',
    'a~b',
    'x:y',
    'x'.repeat(31),
    '.x',
    'feat/.x/',
    'feat./',
    'x.lock/',
    'x.lock',
  ])('rejects prefix %p', async (prefix) => {
    expect(await errorsFor({ prefix, keyCase: 'upper' })).toEqual(['prefix']);
  });

  it('reports invalid_prefix for a pattern violation', async () => {
    const [error] = await validate(
      plainToInstance(UpdateGitBranchSettingsDto, {
        prefix: 'a//b',
        keyCase: 'lower',
      }),
    );

    expect(Object.values(error.constraints ?? {})).toContain('invalid_prefix');
  });

  it.each(['upper', 'lower'])('accepts keyCase %p', async (keyCase) => {
    expect(await errorsFor({ prefix: '', keyCase })).toEqual([]);
  });

  it.each(['mixed', undefined, 'UPPER'])(
    'rejects keyCase %p',
    async (keyCase) => {
      expect(await errorsFor({ prefix: '', keyCase })).toEqual(['keyCase']);
    },
  );

  it('rejects a missing / non-string prefix', async () => {
    expect(await errorsFor({ keyCase: 'upper' })).toEqual(['prefix']);
    expect(await errorsFor({ prefix: 5, keyCase: 'upper' })).toEqual([
      'prefix',
    ]);
  });

  it('BRANCH_PREFIX_PATTERN is the raw rule (no length cap)', () => {
    expect(BRANCH_PREFIX_PATTERN.test('x'.repeat(31))).toBe(true);
    expect(BRANCH_PREFIX_PATTERN.test('a..b')).toBe(false);
  });
});

describe('ConnectGithubInstallationDto', () => {
  const errors = async (installationId: unknown) =>
    (
      await validate(
        plainToInstance(ConnectGithubInstallationDto, {
          token: 't',
          installationId,
        }),
      )
    ).map((error) => error.property);

  it('accepts the id as the picker returns it (a digit string)', async () => {
    expect(await errors('172057129')).toEqual([]);
  });

  it.each([172057129, 'abc', ''])('rejects %p', async (installationId) => {
    expect(await errors(installationId)).toEqual(['installationId']);
  });
});
