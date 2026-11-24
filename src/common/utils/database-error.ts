import { BadRequestException } from '@nestjs/common';

/** Keep the public 400 contract while preserving infrastructure evidence internally. */
export function databaseBadRequest(
  error: { message: string },
  status?: number,
) {
  return new BadRequestException(error.message, {
    description: 'Bad Request',
    cause: { ...error, ...(status === undefined ? {} : { status }) },
  });
}

export function databaseRetryClass(
  error: unknown,
): 'transient' | 'rate_limited' | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as {
    cause?: unknown;
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const nested = e.cause ? databaseRetryClass(e.cause) : null;
  if (nested) return nested;
  if (e.status === 429) return 'rate_limited';
  if (
    e.status === 0 ||
    (typeof e.status === 'number' && e.status >= 500 && e.status <= 599)
  )
    return 'transient';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      '08000',
      '08001',
      '08003',
      '08006',
      '57P01',
      '57P02',
      '57P03',
      '53300',
    ].includes(e.code ?? '')
  )
    return 'transient';
  if (
    (e.name === 'TypeError' && e.message === 'fetch failed') ||
    e.name === 'AbortError' ||
    e.name === 'TimeoutError'
  )
    return 'transient';
  return null;
}
