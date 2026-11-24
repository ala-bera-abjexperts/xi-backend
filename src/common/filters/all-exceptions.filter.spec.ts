import { ArgumentsHost, ForbiddenException, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  const hostFor = (url: string) => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    return {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'GET', url, headers: {} }),
      }),
    } as unknown as ArgumentsHost;
  };

  // Guards throw before the logging interceptor runs, so this is the only log line
  // of a refused or failed search.
  it('never writes search text or tokens to the log of a failed request', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const filter = new AllExceptionsFilter();
    const url = '/api/v1/chat/search?q=geheim&token=abc';

    filter.catch(
      new ForbiddenException('Insufficient permissions'),
      hostFor(url),
    );
    filter.catch(new Error('boom'), hostFor(url));

    expect(warn.mock.calls[0][0]).toContain(
      'GET /api/v1/chat/search?q=***&token=*** - 403',
    );
    expect(error.mock.calls[0][0]).toBe(
      'GET /api/v1/chat/search?q=***&token=*** - 500',
    );
  });
});
