import { HttpException } from '@nestjs/common';
import {
  normalizeScimPatch,
  normalizeScimUserName,
  parseScimFilter,
  parseScimPaging,
} from './scim.util';

function scimErrorOf(fn: () => unknown): { status: number; scimType: unknown } {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;

    return {
      status: httpError.getStatus(),
      scimType: (httpError.getResponse() as { scimType?: unknown }).scimType,
    };
  }

  throw new Error('expected a SCIM error');
}

describe('normalizeScimPatch', () => {
  it('accepts Entra path + value ops with a "False" string', () => {
    expect(
      normalizeScimPatch({
        Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
      }),
    ).toMatchObject({ active: false });
    expect(
      normalizeScimPatch({
        Operations: [{ op: 'replace', path: 'active', value: 'TRUE' }],
      }),
    ).toMatchObject({ active: true });
  });

  it('rejects a non-boolean active with invalidValue', () => {
    expect(
      scimErrorOf(() =>
        normalizeScimPatch({
          Operations: [{ op: 'Replace', path: 'active', value: 'nope' }],
        }),
      ),
    ).toEqual({ status: 400, scimType: 'invalidValue' });
  });

  it('expands path-less value objects, including dotted and nested keys', () => {
    expect(
      normalizeScimPatch({
        Operations: [
          {
            op: 'replace',
            value: {
              active: false,
              'name.givenName': 'Ada',
              externalId: 'ext-1',
            },
          },
          { op: 'Add', value: { name: { familyName: 'Lovelace' } } },
          { op: 'Replace', path: 'userName', value: 'Ada@Example.com' },
        ],
      }),
    ).toEqual({
      active: false,
      givenName: 'Ada',
      familyName: 'Lovelace',
      externalId: 'ext-1',
      userName: 'Ada@Example.com',
      addMembers: [],
      removeMembers: [],
    });
  });

  it('ignores emails, enterprise manager and other unsupported paths', () => {
    expect(
      normalizeScimPatch({
        Operations: [
          {
            op: 'Add',
            path: 'emails[type eq "work"].value',
            value: 'x@example.com',
          },
          {
            op: 'Add',
            path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager',
            value: 'mgr',
          },
          { op: 'Replace', path: 'title', value: 'CTO' },
        ],
      }),
    ).toEqual({ addMembers: [], removeMembers: [] });
  });

  it('accepts members add and both documented remove forms', () => {
    expect(
      normalizeScimPatch({
        Operations: [
          {
            op: 'Add',
            path: 'members',
            value: [{ value: 'u1' }, { value: 'u2' }],
          },
          { op: 'Remove', path: 'members', value: [{ value: 'u3' }] },
          { op: 'remove', path: 'members[value eq "u4"]' },
        ],
      }),
    ).toEqual({ addMembers: ['u1', 'u2'], removeMembers: ['u3', 'u4'] });
  });

  it('rejects unknown ops and a missing Operations array', () => {
    expect(
      scimErrorOf(() =>
        normalizeScimPatch({ Operations: [{ op: 'move', path: 'active' }] }),
      ).status,
    ).toBe(400);
    expect(scimErrorOf(() => normalizeScimPatch({})).status).toBe(400);
  });
});

describe('parseScimFilter', () => {
  const USER_ATTRS = ['userName', 'externalId'];
  const GROUP_ATTRS = ['displayName', 'externalId', 'id'];

  it('parses attr eq "value" case-insensitively, with escaped quotes', () => {
    expect(parseScimFilter('USERNAME eq "a@b.com"', USER_ATTRS)).toEqual({
      attribute: 'userName',
      value: 'a@b.com',
    });
    expect(
      parseScimFilter('displayName eq "Sales \\"EU\\""', GROUP_ATTRS),
    ).toEqual({ attribute: 'displayName', value: 'Sales "EU"' });
  });

  it('parses the Entra membership probe for groups only', () => {
    expect(
      parseScimFilter('id eq "g1" and members[value eq "u1"]', GROUP_ATTRS),
    ).toEqual({ attribute: 'id', value: 'g1', memberValue: 'u1' });
    expect(
      scimErrorOf(() =>
        parseScimFilter('id eq "g1" and members[value eq "u1"]', USER_ATTRS),
      ),
    ).toEqual({ status: 400, scimType: 'invalidFilter' });
  });

  it('returns null without a filter and rejects anything else', () => {
    expect(parseScimFilter(undefined, USER_ATTRS)).toBeNull();

    for (const filter of [
      'userName co "a"',
      'userName eq "a" or userName eq "b"',
      'emails eq "a@b.com"',
      'userName eq a@b.com',
    ]) {
      expect(scimErrorOf(() => parseScimFilter(filter, USER_ATTRS))).toEqual({
        status: 400,
        scimType: 'invalidFilter',
      });
    }
  });
});

describe('paging and userName', () => {
  it('defaults and caps paging', () => {
    expect(parseScimPaging(undefined, undefined)).toEqual({
      startIndex: 1,
      count: 100,
    });
    expect(parseScimPaging('0', '500')).toEqual({ startIndex: 1, count: 100 });
    expect(parseScimPaging('11', '10')).toEqual({ startIndex: 11, count: 10 });
  });

  it('lowercases userName and requires an email', () => {
    expect(normalizeScimUserName(' Ada@Example.COM ')).toBe('ada@example.com');
    expect(scimErrorOf(() => normalizeScimUserName('ada'))).toEqual({
      status: 400,
      scimType: 'invalidValue',
    });
  });
});
