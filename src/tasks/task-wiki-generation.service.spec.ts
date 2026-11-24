import { BadRequestException } from '@nestjs/common';

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) =>
    (value ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript:/gi, ''),
}));

import { TaskWikiGenerationService } from './task-wiki-generation.service';

function createService(client: unknown = {}) {
  return new TaskWikiGenerationService(
    { getClient: () => client } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('TaskWikiGenerationService', () => {
  it('sanitizes AI-generated EditorJS content and rejects unsafe block types', () => {
    const service = createService() as unknown as {
      parseAiWikiContent(text: string): {
        title: string;
        blocks: Array<{ type: string; data: Record<string, unknown> }>;
      };
    };

    const content = service.parseAiWikiContent(
      JSON.stringify({
        title: 'Generated page',
        blocks: [
          {
            type: 'raw',
            data: { html: '<script>alert("xss")</script>' },
          },
          {
            type: 'paragraph',
            data: {
              text: 'Hello <strong>team</strong><img src=x onerror=alert(1)>',
            },
          },
          {
            type: 'list',
            data: {
              style: 'unordered',
              items: [
                '<a href="javascript:alert(1)">unsafe link</a>',
                { content: '<em>safe</em>', items: [] },
              ],
            },
          },
          {
            type: 'table',
            data: {
              content: [['Name', '<span onclick=alert(1)>Value</span>']],
            },
          },
        ],
      }),
    );

    expect(content.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'list',
      'table',
    ]);

    const serialized = JSON.stringify(content.blocks);
    expect(serialized).toContain('<strong>team</strong>');
    expect(serialized).toContain('<em>safe</em>');
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('onerror');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('javascript:');
  });

  it('enforces wiki nesting depth when creating generated pages', async () => {
    const single = jest.fn().mockResolvedValue({
      data: {
        path: [],
        level: 10,
        space_id: 'space-1',
        is_archived: false,
      },
      error: null,
    });
    const eq = jest.fn().mockReturnValue({ single });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });
    const service = createService({ from }) as unknown as {
      createWikiPage(args: {
        spaceId: string;
        organizationId: string;
        userId: string;
        title: string;
        editorJsContent: string;
        generationId: string;
        parentPageId: string | null;
        taskId: string;
        taskKey: string;
      }): Promise<unknown>;
    };

    await expect(
      service.createWikiPage({
        spaceId: 'space-1',
        organizationId: 'org-1',
        userId: 'user-1',
        title: 'Generated page',
        editorJsContent: '{"blocks":[]}',
        generationId: 'generation-1',
        parentPageId: 'parent-1',
        taskId: 'task-1',
        taskKey: 'TASK-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(from).toHaveBeenCalledTimes(1);
  });
});
