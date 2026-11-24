import { ContentTransformService } from './content-transform.service';
import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';

describe('native communication macros', () => {
  it.each(['ac:structured-macro', 'ac:macro'])('preserves settings through %s and the storage validator', async tag => {
    const service = new ContentTransformService({} as never);
    const result = await service.renderBodyAsTipTap({ format: 'storage', value: `<${tag} ac:name="toc"><ac:parameter ac:name="minLevel">2</ac:parameter></${tag}><${tag} ac:name="blog-posts"><ac:parameter ac:name="content">excerpts</ac:parameter></${tag}><${tag} ac:name="rss"><ac:parameter ac:name="url"><ri:url ri:value="https://example.org/feed"/></ac:parameter></${tag}>` }, { orgId: 'org', connectionId: 'conn' });
    const doc = JSON.parse(validateTipTapDoc(result.content).json);
    expect(doc.content.map((node: { type: string }) => node.type)).toEqual(['confluenceToc', 'blogPosts', 'rssFeed']);
    expect(doc.content[0].attrs.params.minLevel).toBe('2');
    expect(doc.content[1].attrs.params.content).toBe('excerpts');
    expect(doc.content[2].attrs.params.url).toBe('https://example.org/feed');
  });
});
