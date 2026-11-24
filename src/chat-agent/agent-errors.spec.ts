import { z } from 'zod';

import {
  TenantAiError,
  type TenantAiErrorKind,
} from '../ai-automation/tenant-ai.service';
import { classifyRunError, isRetryableAttempt } from './agent-errors';

const aiError = (kind: TenantAiErrorKind) => new TenantAiError(kind, 'x');

describe('classifyRunError', () => {
  it.each<[TenantAiErrorKind, string]>([
    ['auth', 'invalid_key'],
    ['quota', 'invalid_key'],
    ['not_configured', 'invalid_key'],
    ['rate_limited', 'rate_limited'],
    ['provider_down', 'provider_down'],
    ['timeout', 'timeout'],
    ['too_large', 'too_large'],
    ['invalid_output', 'failed'],
    ['refused', 'failed'],
    ['model_not_found', 'failed'],
    ['bad_request', 'failed'],
  ])('maps %s to %s', (kind, code) => {
    expect(classifyRunError(aiError(kind), { aborted: false })).toMatchObject({
      status: 'failed',
      code,
    });
  });

  it('notifies admins and offers no Retry only for invalid_key', () => {
    expect(classifyRunError(aiError('auth'), { aborted: false })).toEqual({
      status: 'failed',
      code: 'invalid_key',
      retryable: false,
      notifyAdmins: true,
    });
    expect(classifyRunError(aiError('timeout'), { aborted: false })).toEqual({
      status: 'failed',
      code: 'timeout',
      retryable: true,
      notifyAdmins: false,
    });
  });

  it('checks the Stop first, so an abort is never a timeout', () => {
    for (const kind of ['timeout', 'auth', 'provider_down'] as const) {
      expect(classifyRunError(aiError(kind), { aborted: true })).toEqual({
        status: 'cancelled',
      });
    }
    expect(classifyRunError(new Error('boom'), { aborted: true })).toEqual({
      status: 'cancelled',
    });
  });

  it('treats a cancelled TenantAiError as cancelled', () => {
    expect(classifyRunError(aiError('cancelled'), { aborted: false })).toEqual({
      status: 'cancelled',
    });
  });

  it('maps network errors outside TenantAiError to provider_down', () => {
    const fetchFailed = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }),
    });
    const undici = Object.assign(new Error('connect'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const nested = new Error('wrapped', {
      cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
    });
    for (const err of [fetchFailed, undici, nested]) {
      expect(classifyRunError(err, { aborted: false })).toMatchObject({
        code: 'provider_down',
        retryable: true,
      });
    }
  });

  it('maps a schema mismatch and plain bugs to failed', () => {
    const zodError = z.object({ a: z.string() }).safeParse({}).error;
    for (const err of [
      zodError,
      new TypeError('x is undefined'),
      'str',
      null,
    ]) {
      expect(classifyRunError(err, { aborted: false })).toEqual({
        status: 'failed',
        code: 'failed',
        retryable: true,
        notifyAdmins: false,
      });
    }
  });
});

describe('isRetryableAttempt', () => {
  it('retries only rate_limited and provider_down', () => {
    const all: TenantAiErrorKind[] = [
      'auth',
      'model_not_found',
      'rate_limited',
      'quota',
      'provider_down',
      'timeout',
      'cancelled',
      'too_large',
      'refused',
      'invalid_output',
      'bad_request',
      'not_configured',
    ];
    expect(all.filter(isRetryableAttempt)).toEqual([
      'rate_limited',
      'provider_down',
    ]);
  });
});
