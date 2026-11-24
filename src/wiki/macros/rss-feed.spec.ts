import { parseFeed, validateFeedUrl } from './rss-feed';

describe('RSS feed', () => {
  it('reads RSS descriptions and removes executable content and links', () => {
    const feed = parseFeed(
      '<rss><channel><title>Updates</title><link>https://example.org</link><item><title>Ready</title><link>javascript:alert(1)</link><description><![CDATA[<p>Approved</p><script>alert(1)</script><img src="https://tracker.test/x">]]></description></item></channel></rss>',
    );
    expect(feed.title).toBe('Updates');
    expect(feed.items[0]).toMatchObject({
      title: 'Ready',
      url: null,
      content: '<p>Approved</p>',
    });
  });
  it('reads namespaced Atom and RDF feeds', () => {
    expect(
      parseFeed(
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Updates</title><entry><title>Ready</title><link href="https://example.org/post"/><summary>Done</summary></entry></feed>',
      ).items[0],
    ).toMatchObject({
      title: 'Ready',
      url: 'https://example.org/post',
      content: 'Done',
    });
    expect(
      parseFeed(
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>News</title></channel><item><title>Ready</title></item></rdf:RDF>',
      ).items,
    ).toHaveLength(1);
  });
  it('preserves Atom XHTML formatting', () => {
    const feed = parseFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Ready</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p><strong>Approved</strong></p></div></content></entry></feed>',
    );
    expect(feed.items[0].content).toContain('<strong>Approved</strong>');
  });
  it('distinguishes empty feeds from malformed XML and rejects entities', () => {
    expect(
      parseFeed('<rss><channel><title>Empty</title></channel></rss>').items,
    ).toEqual([]);
    for (const input of [
      '<html>Login</html>',
      '<rss>',
      '<!DOCTYPE rss [<!ENTITY x "test">]><rss><channel/></rss>',
    ]) {
      expect(() => parseFeed(input)).toThrow();
    }
  });
  it('rejects credentials, private literal hosts and unsupported protocols', async () => {
    for (const url of [
      'file:///etc/passwd',
      'https://user:pass@example.org',
      'http://127.0.0.1',
      'https://[::ffff:7f00:1]',
      'http://169.254.169.254',
    ]) {
      await expect(validateFeedUrl(url)).rejects.toThrow();
    }
  });
});

// A real public request exercises Node's lookup callback contract; opt in for network verification.
(process.env.TEST_PUBLIC_RSS === '1' ? it : it.skip)(
  'fetches a real RSS feed with pinned DNS',
  async () => {
    const { fetchFeed } = await import('./rss-feed');
    const feed = await fetchFeed('https://status.atlassian.com/history.rss');
    expect(feed.title).toContain('Atlassian');
    expect(feed.items.length).toBeGreaterThan(0);
  },
  15_000,
);
