import {
  ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ScimTokenGuard } from './scim-token.guard';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'xis_scim_abc123';

type Result = { data?: unknown; error?: { message: string } | null };
type Call = { table: string; method: string; args: unknown[] };

/** Chainable PostgREST mock: each awaited query on a table takes that table's next result. */
function createClient(results: Record<string, Result[]>) {
  const calls: Call[] = [];
  const from = jest.fn((table: string) => {
    const builder: Record<string, unknown> = {};

    for (const method of [
      'select',
      'update',
      'eq',
      'is',
      'order',
      'limit',
      'maybeSingle',
    ]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });

        return builder;
      };
    }

    builder.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({
        data: null,
        error: null,
        ...(results[table]?.shift() ?? {}),
      }).then(resolve, reject);

    return builder;
  });

  return { client: { from }, calls };
}

function run(
  results: Record<string, Result[]>,
  headers: Record<string, string>,
) {
  const { client, calls } = createClient(results);
  const guard = new ScimTokenGuard({ getClient: () => client } as any);
  const request: Record<string, unknown> = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { promise: guard.canActivate(context), request, calls, client };
}

describe('ScimTokenGuard', () => {
  it.each([
    [{}],
    [{ authorization: `Basic ${TOKEN}` }],
    [{ authorization: 'Bearer abc' }],
    [{ authorization: 'Bearer' }],
  ])('rejects %j with 401 and no DB call', async (headers) => {
    const { promise, client } = run({}, headers);

    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('only matches non-revoked tokens and rejects an unknown or revoked one', async () => {
    const { promise, calls } = run(
      { scim_tokens: [{ data: null }] },
      { authorization: `Bearer ${TOKEN}` },
    );

    await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toContainEqual({
      table: 'scim_tokens',
      method: 'is',
      args: ['revoked_at', null],
    });
    expect(calls.find((call) => call.method === 'eq')?.args[1]).not.toContain(
      TOKEN,
    );
  });

  it('takes the org only from the token row, ignoring any org header', async () => {
    const { promise, request } = run(
      {
        scim_tokens: [
          { data: { id: 'token-1', organization_id: ORG, created_by: 'u-1' } },
          {},
        ],
      },
      {
        authorization: `bearer ${TOKEN}`,
        'x-organization-id': OTHER_ORG,
      },
    );

    await expect(promise).resolves.toBe(true);
    expect(request.scim).toEqual({
      orgId: ORG,
      tokenId: 'token-1',
      creatorUserId: 'u-1',
      actorUserId: 'u-1',
    });
  });

  it('uses the org owner as actor when the creator was deleted', async () => {
    const { promise, request, calls } = run(
      {
        scim_tokens: [
          { data: { id: 'token-1', organization_id: ORG, created_by: null } },
          {},
        ],
        organization_members: [{ data: { user_id: 'owner-1' } }],
      },
      { authorization: `Bearer ${TOKEN}` },
    );

    await expect(promise).resolves.toBe(true);
    expect(request.scim).toMatchObject({
      creatorUserId: null,
      actorUserId: 'owner-1',
    });
    expect(calls).toContainEqual({
      table: 'organization_members',
      method: 'eq',
      args: ['role', 'owner'],
    });
  });

  it('fails with 500, not a pass, when the lookup errors', async () => {
    const { promise } = run(
      { scim_tokens: [{ error: { message: 'db down' } }] },
      { authorization: `Bearer ${TOKEN}` },
    );

    await expect(promise).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
