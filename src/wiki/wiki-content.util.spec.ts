import {
  extractTipTapUserMentionIds,
  tiptapToPlainText,
} from './wiki-content.util';

describe('tiptapToPlainText advanced macro mappings', () => {
  it('indexes the exact mapped task key stored by a Jira work-item card', () => {
    expect(
      tiptapToPlainText({
        type: 'doc',
        content: [
          {
            type: 'taskCard',
            attrs: { config: { taskKey: 'ENG-9' } },
          },
        ],
      }),
    ).toBe('ENG-9');
  });

  it('indexes the board name snapshot stored by a whiteboard embed', () => {
    expect(
      tiptapToPlainText({
        type: 'doc',
        content: [
          {
            type: 'whiteboardEmbed',
            attrs: { config: { whiteboardId: 'wb-1', name: 'Retro board' } },
          },
          { type: 'whiteboardEmbed', attrs: { config: {} } },
        ],
      }),
    ).toBe('Retro board');
  });

  it('uses the userMention attributes stored by the editor and importer', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'userMention',
          attrs: {
            userId: '11111111-1111-4111-8111-111111111111',
            userName: 'Ada Lovelace',
          },
        },
      ],
    };

    expect(tiptapToPlainText(document)).toBe('Ada Lovelace');
    expect(extractTipTapUserMentionIds(document)).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });
});
