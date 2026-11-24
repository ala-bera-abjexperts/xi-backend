import type { ParsedMacro } from './canonical-ir';
import { renderMacro } from './macros/macro-registry';

const macro = (name: string, params: Record<string, string>): ParsedMacro => ({
  name,
  params,
  richBody: [],
  plainBody: '',
});

describe('safe iframe, widget, cards and carousel macros', () => {
  it.each(['iframe', 'widget', 'widget-connector'])(
    'maps allowlisted %s video URLs to safeEmbed',
    (name) => {
      expect(
        renderMacro(
          macro(name, {
            url: 'https://vimeo.com/123456',
            width: '720',
            height: '405',
          }),
          {},
        ),
      ).toMatchObject({
        type: 'safeEmbed',
        sourceMacro: name,
        url: 'https://vimeo.com/123456',
        embedUrl: 'https://player.vimeo.com/video/123456',
        width: 720,
        height: 405,
      });
    },
  );

  it.each([
    'https://localhost/private',
    'https://example.com/embed',
    'http://www.youtube.com/watch?v=CNeuec8ybc4',
  ])('preserves blocked iframe URL %s as an exact fidelity card', (url) => {
    const params = { url, width: '99999', custom: 'keep-me' };

    expect(renderMacro(macro('iframe', params), {})).toEqual({
      type: 'externalMacro',
      name: 'iframe',
      params,
    });
  });

  it('maps a simple card to existing inlineCard storage but preserves richer cards', () => {
    expect(
      renderMacro(
        macro('cards', { url: 'https://example.com', title: 'Example' }),
        {},
      ),
    ).toEqual({
      type: 'inlineCard',
      url: 'https://example.com',
      title: 'Example',
      sourceMacro: 'cards',
      sourceParams: {
        url: 'https://example.com',
        title: 'Example',
      },
      sourceBody: '',
    });
    const rich = {
      url: 'https://example.com',
      title: 'Example',
      description: 'Cannot fit inlineCard',
    };

    expect(renderMacro(macro('cards', rich), {})).toEqual({
      type: 'externalMacro',
      name: 'cards',
      params: rich,
    });
  });

  it('normalizes at most three carousel frames while preserving source parameters', () => {
    const params = {
      title1: 'One',
      link1: '/one',
      description1: 'First',
      title2: 'Two',
      link2: '/two',
      description2: 'Second',
      title3: 'Three',
      link3: '/three',
      description3: 'Third',
      title4: 'Four',
      link4: '/four',
      custom: 'keep-me',
    };

    expect(renderMacro(macro('carousel', params), {})).toMatchObject({
      type: 'carousel',
      frames: [
        { title: 'One', url: '/one', description: 'First' },
        { title: 'Two' },
        { title: 'Three' },
      ],
      sourceParams: params,
    });
  });
});
