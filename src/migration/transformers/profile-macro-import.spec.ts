import { ContentTransformService } from './content-transform.service';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';
const USER = '267b6a1d-6a5e-4d63-b544-d869f85ee906';

describe('native Confluence profile imports', () => {
  it.each(['ac:structured-macro', 'ac:macro'])('resolves %s user references and retains provenance through validation', async tag => {
    const resolveProfileTargets = jest.fn().mockResolvedValue(new Map([['server-key', { userId: USER, displayName: 'Source Person' }]]));
    const service = new ContentTransformService({ resolveProfileTargets } as never);
    const rendered = await service.renderBodyAsTipTap({ format: 'storage', value: `<${tag} ac:name="profile-picture"><ac:parameter ac:name="user"><ri:user ri:userkey="server-key"/></ac:parameter></${tag}>` }, { orgId: 'org', connectionId: 'conn', targetSpaceId: 'space' });
    const doc = JSON.parse(validateTipTapDoc(rendered.content).json);
    expect(doc.content[0]).toMatchObject({ type: 'profilePicture', attrs: { userId: USER, userName: 'Source Person', sourceName: 'profile-picture', sourceParams: { user: 'server-key' } } });
    expect(resolveProfileTargets).toHaveBeenCalledWith('org', 'conn', 'space', ['server-key']);
  });
  it('supports Cloud ADF account identities without fetching a source avatar', async () => {
    const resolveProfileTargets = jest.fn().mockResolvedValue(new Map([['cloud:account', { userId: USER }]]));
    const service = new ContentTransformService({ resolveProfileTargets } as never);
    const rendered = await service.renderBodyAsTipTap({ format: 'adf', value: { type: 'doc', version: 1, content: [{ type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'user-profile', parameters: { macroParams: { accountId: { value: 'cloud:account' } } } } }] } }, { orgId: 'org', connectionId: 'conn', targetSpaceId: 'space' });
    const doc = JSON.parse(validateTipTapDoc(rendered.content).json);
    expect(doc.content[0]).toMatchObject({ type: 'userProfile', attrs: { userId: USER, sourceParams: { accountId: 'cloud:account' } } });
    expect(JSON.stringify(doc)).not.toContain('avatar');
  });
  it('does not infer local identity without destination scope, including no-parameter imports', async () => {
    const service = new ContentTransformService({} as never);
    const rendered = await service.renderBodyAsTipTap({ format: 'storage', value: '<ac:structured-macro ac:name="profile-picture"/><ac:structured-macro ac:name="user-profile"/>' }, { orgId: 'org', connectionId: 'conn' });
    const doc = JSON.parse(validateTipTapDoc(rendered.content).json);
    expect(doc.content.map((node: any) => node.attrs.userKey)).toEqual(['confluence:unresolved', 'confluence:unresolved']);
  });
});
