/**
 * getIssueRemoteLinks: Jira's Link -> Web Link resource. This is the only place a "linked
 * document" (PDF, Confluence page) attached to an issue as a web link is visible, so a parse
 * failure here silently drops those documents from every migration.
 */
import { JiraServerAdapter } from './jira-server.adapter';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';

function makeHttp(routes: Record<string, unknown>): AtlassianHttpClient {
  return {
    getJson: jest.fn(async (path: string) => {
      const hit = Object.keys(routes).find((frag) => path.includes(frag));

      if (!hit) throw new Error(`unexpected path ${path}`);

      return routes[hit];
    }),
  } as unknown as AtlassianHttpClient;
}

describe('JiraServerAdapter.getIssueRemoteLinks', () => {
  it('normalizes id/url/title/summary and drops entries without a URL', async () => {
    const http = makeHttp({
      '/remotelink': [
        {
          id: 10000,
          object: {
            url: 'https://confluence.example.com/display/EDV/SNMP',
            title: 'SNMP runbook',
            summary: 'How SNMP is monitored',
          },
        },
        { id: 10001, object: { url: '', title: 'broken' } },
        {
          id: 10002,
          object: { url: 'https://files.example.com/a.pdf', title: '' },
        },
      ],
    });
    const adapter = new JiraServerAdapter(http);

    const links = await adapter.getIssueRemoteLinks('ITPFM-15');

    expect(links).toEqual([
      {
        sourceId: '10000',
        url: 'https://confluence.example.com/display/EDV/SNMP',
        title: 'SNMP runbook',
        summary: 'How SNMP is monitored',
      },
      { sourceId: '10002', url: 'https://files.example.com/a.pdf', title: '' },
    ]);
  });

  it('degrades an unreadable remotelink resource to [] instead of failing the run', async () => {
    const http = makeHttp({}); // no route → getJson throws
    const adapter = new JiraServerAdapter(http);

    await expect(adapter.getIssueRemoteLinks('X-1')).resolves.toEqual([]);
  });
});
