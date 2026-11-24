import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { LoggingInterceptor, redactUrlForLog } from './logging.interceptor';

describe('redactUrlForLog', () => {
  it('redacts search text, wherever q sits in the query string', () => {
    expect(redactUrlForLog('/api/v1/chat/search?q=streng%20geheim')).toBe(
      '/api/v1/chat/search?q=***',
    );
    expect(
      redactUrlForLog('/api/v1/chat/search?limit=5&q=a+b&pinned=true'),
    ).toBe('/api/v1/chat/search?limit=5&q=***&pinned=true');
  });

  it('leaves parameters alone that only end in q', () => {
    const url =
      '/api/v1/chat/conversations/c1/messages?beforeSeq=40&afterSeq=2';

    expect(redactUrlForLog(url)).toBe(url);
  });

  it('still redacts tokens', () => {
    expect(redactUrlForLog('/api/v1/files?token=abc.def&q=x')).toBe(
      '/api/v1/files?token=***&q=***',
    );
    expect(redactUrlForLog('/cb?access_token=abc&state=1')).toBe(
      '/cb?access_token=***&state=1',
    );
  });
});

describe('LoggingInterceptor', () => {
  afterEach(() => jest.restoreAllMocks());

  it('never writes search text to the request log', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/api/v1/chat/search?q=geheim&limit=5',
          headers: {},
        }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(null) };

    await lastValueFrom(new LoggingInterceptor().intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(
      /^GET \/api\/v1\/chat\/search\?q=\*\*\*&limit=5 200 - \d+ms$/,
    );
  });
});
