jest.mock('./sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) =>
    value == null ? null : String(value),
}));

import { cirToTipTap } from '../../migration/transformers/cir-to-tiptap';
import { tiptapToPlainText } from '../../wiki/wiki-content.util';
import { validateTipTapDoc } from './tiptap-sanitizer';

const resolved = {
  users: new Map(),
  pages: new Map(),
  attachments: new Map(),
  nativeTables: true,
};

describe('safe embed TipTap contracts', () => {
  it('serializes, validates, and indexes safe embeds and carousels', () => {
    const doc = cirToTipTap(
      {
        type: 'doc',
        children: [
          {
            type: 'safeEmbed',
            sourceMacro: 'iframe',
            url: 'https://vimeo.com/123456',
            embedUrl: 'https://player.vimeo.com/video/123456',
            title: 'Demo video',
            sourceParams: { url: 'https://vimeo.com/123456' },
            sourceBody: '',
          },
          {
            type: 'carousel',
            sourceMacro: 'carousel',
            frames: [
              {
                title: 'Release',
                description: 'August release',
                url: '/release',
                image:
                  '/storage/v1/object/public/wiki-attachments/carousel/cover.png',
              },
            ],
            sourceParams: { title1: 'Release' },
            sourceBody: '',
          },
          {
            type: 'inlineCard',
            url: 'https://example.com',
            title: 'Example',
            sourceMacro: 'cards',
            sourceParams: { link: 'https://example.com' },
            sourceBody: '',
          },
        ],
      },
      resolved,
    );

    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
    expect(tiptapToPlainText(doc)).toContain('Demo video');
    expect(tiptapToPlainText(doc)).toContain('Release');
    expect(tiptapToPlainText(doc)).toContain('August release');
  });

  it('rejects arbitrary embed origins and oversized carousels', () => {
    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [
            { type: 'safeEmbed', attrs: { url: 'https://localhost/private' } },
          ],
        }),
      ),
    ).toThrow(/provider is not allowed/);

    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'carousel',
              attrs: {
                frames: Array.from({ length: 4 }, () => ({
                  title: '',
                  description: '',
                })),
              },
            },
          ],
        }),
      ),
    ).toThrow(/exceeds three frames/);

    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [
            { type: 'safeEmbed', attrs: { url: 'https://youtube.com/admin' } },
          ],
        }),
      ),
    ).toThrow(/provider is not allowed/);

    expect(() =>
      validateTipTapDoc(
        JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'carousel',
              attrs: {
                frames: [
                  {
                    title: '',
                    description: '',
                    image: 'https://example.com/private.png',
                  },
                ],
              },
            },
          ],
        }),
      ),
    ).toThrow(/local public attachment storage/);

    for (const image of ['/api/private', '/admin']) {
      expect(() =>
        validateTipTapDoc(
          JSON.stringify({
            type: 'doc',
            content: [
              {
                type: 'carousel',
                attrs: {
                  frames: [{ title: '', description: '', image }],
                },
              },
            ],
          }),
        ),
      ).toThrow(/local public attachment storage/);
    }
  });
});
