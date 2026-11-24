import { lookup as dnsLookup } from 'dns';

import { checkHeaders, renderTemplate } from '../automation-inputs';
import { checkCiUrl } from '../automation-inputs';

jest.mock('dns', () => ({ lookup: jest.fn() }));

describe('checkHeaders', () => {
  it('keeps ordinary values, including Latin-1 characters', () => {
    expect(checkHeaders({ Authorization: 'Bearer abc', Note: 'café' })).toEqual(
      { Authorization: 'Bearer abc', Note: 'café' },
    );
  });

  it.each([
    ['a euro sign', 'caf€'],
    ['Hindi text', 'नमस्ते'],
    ['an emoji', 'ok 👍'],
  ])('refuses %s, which can never be sent in a header', (_name, value) => {
    expect(() => checkHeaders({ Token: value })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ field: 'ci_headers' }) as object,
      }) as Error,
    );
  });

  it('still refuses a second line', () => {
    expect(() => checkHeaders({ Token: 'a\nb' })).toThrow();
  });
});

describe('renderTemplate', () => {
  it('fills in the test keys', () => {
    expect(
      renderTemplate('{"keys":"{testKeys}","plan":"{planId}"}', {
        testKeys: 'P-1,P-2',
        planId: 'plan-1',
      }),
    ).toBe('{"keys":"P-1,P-2","plan":"plan-1"}');
  });

  it('leaves the test keys empty when there are none', () => {
    expect(renderTemplate('KEYS={testKeys}&RUN={runId}', { runId: 'r' })).toBe(
      'KEYS=&RUN=r',
    );
  });

  it('keeps an unknown name as it is', () => {
    expect(renderTemplate('{testKey}', { testKeys: 'P-1' })).toBe('{testKey}');
  });
});

describe('checkCiUrl', () => {
  const dnsMock = dnsLookup as unknown as jest.Mock;

  function messageOf(error: unknown): unknown {
    return (error as { response?: { message?: unknown } }).response?.message;
  }

  beforeEach(() => {
    dnsMock.mockReset();
  });

  it('says the host could not be found when it does not resolve', async () => {
    dnsMock.mockImplementation(
      (_host: string, _options: unknown, cb: (err: Error) => void) =>
        cb(new Error('getaddrinfo ENOTFOUND ci.example.com')),
    );

    const error: unknown = await checkCiUrl(
      'https://ci.example.com/build',
    ).catch((e: unknown) => e);

    expect(messageOf(error)).toBe(
      'This address could not be found. Check the host name of the CI tool',
    );
  });

  it.each([
    ['a host that resolves to a private address', 'https://ci.example.com/b'],
    ['localhost by address', 'https://127.0.0.1/build'],
    ['a plain http URL', 'http://ci.example.com/build'],
    ['a URL with a password', 'https://u:p@ci.example.com/build'],
  ])('keeps the old message for %s', async (_name, url) => {
    dnsMock.mockImplementation(
      (
        _host: string,
        _options: unknown,
        cb: (err: null, records: { address: string }[]) => void,
      ) => cb(null, [{ address: '10.0.0.5' }]),
    );

    const error: unknown = await checkCiUrl(url).catch((e: unknown) => e);

    expect(messageOf(error)).toBe(
      'Use a public https URL without a user name or password',
    );
  });

  it('accepts a host that resolves to a public address', async () => {
    dnsMock.mockImplementation(
      (
        _host: string,
        _options: unknown,
        cb: (err: null, records: { address: string }[]) => void,
      ) => cb(null, [{ address: '93.184.216.34' }]),
    );

    await expect(checkCiUrl('https://ci.example.com/build')).resolves.toBe(
      'https://ci.example.com/build',
    );
  });
});
