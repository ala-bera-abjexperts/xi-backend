/**
 * XE-T471 — a `pageLink` that the crosswalk has not mapped yet must be reported as unresolved so
 * the page can be flagged `needs_relink` and re-rendered by the `page_relink` stage.
 *
 * `collectRefs` already harvests `pageReferences` for `pageLink`; these pin the pure judgment on
 * top of it (`unresolvedPageReferences`) that the render pass drives its flag from.
 */

import {
  collectRefs,
  pageReferenceKey,
  unresolvedPageReferences,
  type CirDoc,
} from './canonical-ir';

function docWithPageLink(
  pageSourceId = 'AM Topics',
  sourceSpaceKey?: string,
): CirDoc {
  return {
    type: 'doc',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'pageLink',
            pageSourceId,
            ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
            fragment: 'release-notes',
            text: 'Read more',
          },
        ],
      },
    ],
  };
}

describe('unresolvedPageReferences (XE-T471)', () => {
  it('reports a pageLink whose target is not in the crosswalk yet', () => {
    const refs = collectRefs(docWithPageLink('AM Topics', 'APMIS'));

    expect(
      refs.pageReferences.has(pageReferenceKey('AM Topics', 'APMIS')),
    ).toBe(true);
    expect(unresolvedPageReferences(refs, new Map())).toEqual([
      {
        key: pageReferenceKey('AM Topics', 'APMIS'),
        sourceId: 'AM Topics',
        sourceSpaceKey: 'APMIS',
      },
    ]);
  });

  it('reports nothing once the crosswalk resolves every page reference', () => {
    const refs = collectRefs(docWithPageLink('AM Topics', 'APMIS'));
    const resolved = new Map([
      [
        pageReferenceKey('AM Topics', 'APMIS'),
        { pageId: '11111111-1111-4111-8111-111111111111' },
      ],
    ]);

    expect(unresolvedPageReferences(refs, resolved)).toEqual([]);
  });

  it('reports only the references still missing when some resolve', () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'pageLink', pageSourceId: 'Present', text: 'Present' },
            { type: 'pageLink', pageSourceId: 'Missing', text: 'Missing' },
          ],
        },
      ],
    };
    const refs = collectRefs(doc);
    const resolved = new Map([
      [pageReferenceKey('Present'), { pageId: 'page-1' }],
    ]);

    expect(unresolvedPageReferences(refs, resolved)).toEqual([
      { key: pageReferenceKey('Missing'), sourceId: 'Missing' },
    ]);
  });

  it('reports nothing for a document without page links', () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: 'plain' }],
        },
      ],
    };

    expect(unresolvedPageReferences(collectRefs(doc), new Map())).toEqual([]);
  });
});
