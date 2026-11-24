import { mapProfileMacros } from './profile-macro-identity';
const USER = '267b6a1d-6a5e-4d63-b544-d869f85ee906';
const native = (params = { user: 'source-key' }) => ({ type: 'profilePicture', attrs: { sourceName: 'profile-picture', sourceParams: params, sourceBody: '' } });
const doc = (...content: any[]) => ({ type: 'doc', content });
const lookup = jest.fn(async () => new Map([['source-key', { userId: USER, displayName: 'Source Person' }]]));

describe('profile macro import and scoped repair', () => {
  beforeEach(() => lookup.mockClear());
  it('maps a source identity but never treats UUID-shaped source IDs as local IDs', async () => {
    const result = await mapProfileMacros(doc(native(), native({ user: USER })), lookup);
    expect(result.content?.[0].attrs).toMatchObject({ userId: USER, userName: 'Source Person', sourceParams: { user: 'source-key' } });
    expect(result.content?.[1].attrs).toMatchObject({ userKey: `confluence:${USER}` });
    expect(result.content?.[1].attrs?.userId).toBeUndefined();
  });
  it('leaves empty imports explicitly unresolved and retains original params', async () => {
    const result = await mapProfileMacros(doc(native({} as any)), lookup);
    expect(result.content?.[0].attrs).toMatchObject({ userKey: 'confluence:unresolved', sourceParams: {} });
  });
  it('repairs only mapped imported nodes and preserves edited prose and unrelated macros exactly', async () => {
    const prose = { type: 'paragraph', content: [{ type: 'text', text: 'Keep this edited text.' }] };
    const card = { type: 'externalMacro', attrs: { name: 'profile-picture', params: { user: 'source-key' } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'profile-picture (external macro)', marks: [{ type: 'italic' }] }] }] };
    const unresolved = native({ user: 'missing' });
    const original = doc(prose, card, unresolved, { type: 'toc', attrs: { maxDepth: 3 } });
    const before = JSON.stringify(original);
    const result = await mapProfileMacros(original, lookup, true);
    expect(result.content?.[1]).toMatchObject({ type: 'profilePicture', attrs: { userId: USER } });
    expect(result.content?.[0]).toEqual(prose);
    expect(result.content?.[2]).toEqual(unresolved);
    expect(result.content?.[3]).toEqual(original.content[3]);
    expect(JSON.stringify(original)).toBe(before);
    expect(await mapProfileMacros(result, lookup, true)).toEqual(result);
  });
  it('preserves unsupported parameters, customized card content and manually configured native profiles', async () => {
    const original = doc({ type: 'externalMacro', attrs: { name: 'profile-picture', params: { user: 'source-key', size: 'huge' } } }, { type: 'externalMacro', attrs: { name: 'profile-picture', params: { user: 'source-key' } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'User annotation' }] }] }, { type: 'profilePicture', attrs: { userKey: 'source-key' } });
    expect(await mapProfileMacros(original, lookup, true)).toEqual(original);
  });
  it('repairs a legacy native source alias only after unambiguous source confirmation', async () => {
    const legacy = { type: 'profilePicture', attrs: { userName: 'source-key' } };
    const source = doc(native());
    expect(await mapProfileMacros(doc(legacy), lookup, true)).toEqual(doc(legacy));
    expect((await mapProfileMacros(doc(legacy), lookup, true, source)).content?.[0].attrs?.userId).toBe(USER);
    expect(await mapProfileMacros(doc(legacy, legacy), lookup, true, source)).toEqual(doc(legacy, legacy));
  });
  it('requires all supplied source aliases to agree', async () => {
    const original = doc(native({ user: 'source-key', accountId: 'unknown' } as any));
    expect((await mapProfileMacros(original, lookup)).content?.[0].attrs?.userId).toBeUndefined();
  });
});
