import { AtlassianRequestError } from '../http/atlassian-http-client';
import type { AtlassianHttpClient } from '../http/atlassian-http-client';
import { JiraCloudAdapter } from './jira-cloud.adapter';
import { JiraServerAdapter } from './jira-server.adapter';

function harness<T extends JiraCloudAdapter | JiraServerAdapter>(
  Adapter: new (http: AtlassianHttpClient) => T,
) {
  const getJson = jest.fn();
  const adapter = new Adapter({ getJson } as unknown as AtlassianHttpClient);
  return { adapter, getJson };
}

describe('Jira issue watchers', () => {
  it('uses Cloud accountId, normalizes users, and deduplicates identities', async () => {
    const { adapter, getJson } = harness(JiraCloudAdapter);
    getJson.mockResolvedValue({
      watchCount: 2,
      watchers: [
        {
          accountId: 'cloud-1',
          displayName: 'Ada',
          emailAddress: ' ADA@example.com ',
          active: true,
        },
        { accountId: 'cloud-1', displayName: 'Ada duplicate' },
        { accountId: 'cloud-2', displayName: 'Grace', active: false },
      ],
    });

    await expect(adapter.getIssueWatchers('ABC-1')).resolves.toEqual({
      total: 2,
      watchers: [
        expect.objectContaining({
          sourceId: 'cloud-1',
          email: 'ada@example.com',
          displayName: 'Ada',
          active: true,
        }),
        expect.objectContaining({
          sourceId: 'cloud-2',
          displayName: 'Grace',
          active: false,
        }),
      ],
    });
    expect(getJson).toHaveBeenCalledWith('/rest/api/3/issue/ABC-1/watchers');
  });

  it('prefers Server user key and falls back to username', async () => {
    const { adapter, getJson } = harness(JiraServerAdapter);
    getJson.mockResolvedValue({
      watchCount: 2,
      watchers: [
        { key: 'JIRAUSER100', name: 'old-login', displayName: 'Keyed' },
        { username: 'fallback-login', displayName: 'Fallback' },
      ],
    });

    const result = await adapter.getIssueWatchers('10001');

    expect(result.watchers).toEqual([
      expect.objectContaining({
        sourceId: 'JIRAUSER100',
        username: 'old-login',
      }),
      expect.objectContaining({
        sourceId: 'fallback-login',
        username: 'fallback-login',
      }),
    ]);
    expect(getJson).toHaveBeenCalledWith('/rest/api/2/issue/10001/watchers');
  });

  it.each([
    [JiraCloudAdapter, 'cloud'],
    [JiraServerAdapter, 'server'],
  ] as const)('%s returns a genuine empty list', async (Adapter) => {
    const { adapter, getJson } = harness(Adapter);
    getJson.mockResolvedValue({ watchCount: 0, watchers: [] });

    await expect(adapter.getIssueWatchers('ABC-1')).resolves.toEqual({
      total: 0,
      watchers: [],
    });
  });

  it('rejects malformed Cloud identities instead of returning partial success', async () => {
    const { adapter, getJson } = harness(JiraCloudAdapter);
    getJson.mockResolvedValue({
      watchCount: 1,
      watchers: [{ displayName: 'Visible but unidentified' }],
    });

    await expect(adapter.getIssueWatchers('ABC-1')).rejects.toThrow(
      /identity.*incomplete|incomplete.*identity/i,
    );
  });

  it('rejects a visible-identity count below watchCount', async () => {
    const { adapter, getJson } = harness(JiraServerAdapter);
    getJson.mockResolvedValue({
      watchCount: 3,
      watchers: [
        { key: 'u-1', displayName: 'One' },
        { key: 'u-1', displayName: 'Duplicate' },
      ],
    });

    await expect(adapter.getIssueWatchers('ABC-1')).rejects.toThrow(
      /watchCount.*3.*visible.*1/i,
    );
  });

  it.each([401, 403, 404])(
    'propagates source HTTP %s without converting it to zero watchers',
    async (status) => {
      const { adapter, getJson } = harness(JiraCloudAdapter);
      const error = new AtlassianRequestError('watchers unavailable', status);
      getJson.mockRejectedValue(error);

      await expect(adapter.getIssueWatchers('ABC-1')).rejects.toBe(error);
    },
  );

  it('propagates transport errors', async () => {
    const { adapter, getJson } = harness(JiraServerAdapter);
    const error = new Error('socket closed');
    getJson.mockRejectedValue(error);

    await expect(adapter.getIssueWatchers('ABC-1')).rejects.toBe(error);
  });
});
