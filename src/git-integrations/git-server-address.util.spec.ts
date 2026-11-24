/**
 * @fileoverview Unit tests for the self-hosted server address rules (ticket 11): normalisation and the
 * SaaS / on-premise address policy. IP literals only, so no DNS is involved.
 * @module src/git-integrations/git-server-address.util.spec
 */

import {
  GitServerAddressError,
  assertServerAddress,
  isAllowedServerAddress,
  normalizeServerUrl,
  resetServerAddressChecks,
} from './git-server-address.util';

describe('normalizeServerUrl', () => {
  it('lower-cases the host and drops trailing slash, query and fragment', () => {
    expect(
      normalizeServerUrl('  https://GitLab.Company.LOCAL/?x=1#y ', false),
    ).toEqual({
      baseUrl: 'https://gitlab.company.local',
      host: 'gitlab.company.local',
    });
  });

  it('keeps a GitLab relative root and a port', () => {
    expect(
      normalizeServerUrl('https://company.com:8443/gitlab/', false),
    ).toEqual({
      baseUrl: 'https://company.com:8443/gitlab',
      host: 'company.com:8443',
    });
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['ftp://git.local', 'invalid_url'],
    ['https://user:pw@git.local', 'invalid_url'],
    ['https://[::1]/', 'invalid_url'],
    ['https://under_score.local', 'invalid_url'],
  ])('%s → %s', (raw, code) => {
    expect(() => normalizeServerUrl(raw, true)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('refuses http unless allowed (on-premise)', () => {
    expect(() => normalizeServerUrl('http://git.local', false)).toThrow(
      expect.objectContaining({ code: 'http_insecure' }),
    );
    expect(normalizeServerUrl('http://git.local', true).baseUrl).toBe(
      'http://git.local',
    );
  });
});

describe('isAllowedServerAddress', () => {
  it.each([
    ['10.1.2.3', false, false],
    ['10.1.2.3', true, true],
    ['192.168.1.5', true, true],
    ['127.0.0.1', false, false],
    ['127.0.0.1', true, true],
    ['169.254.169.254', true, false],
    ['169.254.169.254', false, false],
    ['0.0.0.0', true, false],
    ['fe80::1', true, false],
    ['140.82.112.3', false, true],
    ['not-an-ip', true, false],
  ])('%s (on-premise %s) → %s', (address, onPremise, allowed) => {
    expect(isAllowedServerAddress(address, onPremise)).toBe(allowed);
  });
});

describe('assertServerAddress', () => {
  beforeEach(() => resetServerAddressChecks());

  it('blocks a private address in SaaS and allows it on-premise', async () => {
    await expect(
      assertServerAddress('https://10.0.0.5', false),
    ).rejects.toMatchObject({ code: 'private_address_blocked' });
    await expect(
      assertServerAddress('https://10.0.0.5', true),
    ).resolves.toBeUndefined();
  });

  it('blocks the metadata address everywhere', async () => {
    await expect(
      assertServerAddress('http://169.254.169.254/latest', true),
    ).rejects.toBeInstanceOf(GitServerAddressError);
  });

  it('remembers a success per mode, never a failure', async () => {
    await assertServerAddress('https://10.0.0.6', true);
    // The SaaS check of the same host is separate and still fails.
    await expect(
      assertServerAddress('https://10.0.0.6', false),
    ).rejects.toMatchObject({ code: 'private_address_blocked' });
  });
});
