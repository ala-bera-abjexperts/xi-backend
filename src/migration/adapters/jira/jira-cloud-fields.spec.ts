/**
 * getFieldsForIssueType fallback: Atlassian Cloud's paginated createmeta resource intermittently
 * returns an empty `values` array. The adapter must then fall back to the legacy createmeta expand,
 * or every custom field (and every custom-field VALUE on every issue) is silently dropped.
 */
import { JiraCloudAdapter } from './jira-cloud.adapter';
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

describe('JiraCloudAdapter.getFieldsForIssueType', () => {
  it('uses the paginated resource when it returns fields', async () => {
    const http = makeHttp({
      'createmeta/BIT/issuetypes/10004': {
        values: [
          {
            fieldId: 'customfield_10423',
            name: 'BIT_external',
            schema: { type: 'number', custom: 'x:float' },
          },
          { fieldId: 'summary', name: 'Summary', schema: { type: 'string' } },
        ],
      },
    });
    const adapter = new JiraCloudAdapter(http);

    const fields = await adapter.getFieldsForIssueType('BIT', '10004');

    expect(fields.map((f) => f.sourceId).sort()).toEqual([
      'customfield_10423',
      'summary',
    ]);
    // Legacy endpoint must not be consulted when the paginated one is populated.
    expect(http.getJson as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('falls back to legacy createmeta when paginated `values` is empty', async () => {
    const http = makeHttp({
      // paginated → empty (the observed Cloud bug)
      'createmeta/BIT/issuetypes/10004': { values: [] },
      // legacy expand → the real fields, as a MAP keyed by field id
      'createmeta?projectKeys=BIT': {
        projects: [
          {
            issuetypes: [
              {
                fields: {
                  customfield_10015: {
                    name: 'Start date',
                    schema: { type: 'date', custom: 'x:datepicker' },
                  },
                  customfield_10423: {
                    name: 'BIT_external',
                    schema: { type: 'number', custom: 'x:float' },
                  },
                  summary: {
                    name: 'Summary',
                    required: true,
                    schema: { type: 'string' },
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const adapter = new JiraCloudAdapter(http);

    const fields = await adapter.getFieldsForIssueType('BIT', '10004');

    const byId = new Map(fields.map((f) => [f.sourceId, f]));

    expect([...byId.keys()].sort()).toEqual([
      'customfield_10015',
      'customfield_10423',
      'summary',
    ]);
    // The id hint (map key) is threaded through so custom fields are recognised.
    expect(byId.get('customfield_10015')?.name).toBe('Start date');
    expect(byId.get('customfield_10015')?.isCustom).toBe(true);
    expect(byId.get('customfield_10423')?.isCustom).toBe(true);
  });

  it('returns [] (never throws) when neither endpoint reports the project/type', async () => {
    const http = makeHttp({
      'createmeta/BIT/issuetypes/10004': { values: [] },
      'createmeta?projectKeys=BIT': { projects: [] },
    });
    const adapter = new JiraCloudAdapter(http);

    await expect(
      adapter.getFieldsForIssueType('BIT', '10004'),
    ).resolves.toEqual([]);
  });
});
