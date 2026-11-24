/**
 * Confluence Cloud user discovery — the two parsing surfaces.
 *
 * Cloud gives no readable user directory: measured with a space-admin token,
 * `/wiki/rest/api/user?accountId=`, `/user/bulk` and every Jira `/rest/api/3/user*` endpoint return
 * 403/401, and a `user.accountid` CQL search comes back empty. So a mention's account id has to be
 * read out of the ADF body, and the person's NAME out of the rendered body — these two functions are
 * the whole channel, and both fail silently if they drift.
 */

import {
  collectMentionIds,
  renderedMentionLabels,
} from './confluence-cloud.adapter';

describe('collectMentionIds', () => {
  const doc = (...content: unknown[]) =>
    JSON.stringify({ type: 'doc', version: 1, content });

  it('finds a mention nested inside list items and table cells', () => {
    const adf = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'mention', attrs: { id: 'acc-deep', text: '' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(collectMentionIds(adf)).toEqual(['acc-deep']);
  });

  it('returns every occurrence so the caller can count references, not just people', () => {
    const adf = doc(
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a' } }] },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a' } }] },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'b' } }] },
    );

    expect(collectMentionIds(adf)).toEqual(['a', 'a', 'b']);
  });

  it('ignores a mention with no id rather than emitting undefined', () => {
    const adf = doc({
      type: 'paragraph',
      content: [{ type: 'mention', attrs: {} }],
    });

    expect(collectMentionIds(adf)).toEqual([]);
  });

  it('survives an absent or malformed body instead of throwing mid-scan', () => {
    // A single unparseable page must not abort discovery for the whole space.
    expect(collectMentionIds(undefined)).toEqual([]);
    expect(collectMentionIds('')).toEqual([]);
    expect(collectMentionIds('{not json')).toEqual([]);
  });
});

describe('renderedMentionLabels', () => {
  it('pairs the account id with the display name Confluence renders', () => {
    // This is the ONLY channel that names someone who has never authored a page — verified against
    // the customer's space, where it resolved 2 of the 3 referenced people.
    const html =
      '<p><a class="confluence-userlink user-mention" ' +
      'data-account-id="557058:d14e1fba" href="/wiki/people/557058:d14e1fba">Christian Kienzl</a></p>';

    expect(renderedMentionLabels(html)).toEqual([
      ['557058:d14e1fba', 'Christian Kienzl'],
    ]);
  });

  it('reads several mentions from one page', () => {
    const html =
      '<a data-account-id="a">Michael Meislinger</a> and <a data-account-id="b">Tobias Schwap</a>';

    expect(renderedMentionLabels(html)).toEqual([
      ['a', 'Michael Meislinger'],
      ['b', 'Tobias Schwap'],
    ]);
  });

  it('skips an anchor with an empty label rather than storing a blank name', () => {
    expect(renderedMentionLabels('<a data-account-id="a"></a>')).toEqual([]);
    expect(renderedMentionLabels('<a data-account-id="a">   </a>')).toEqual([]);
  });

  it('handles an absent body', () => {
    expect(renderedMentionLabels(undefined)).toEqual([]);
  });
});
