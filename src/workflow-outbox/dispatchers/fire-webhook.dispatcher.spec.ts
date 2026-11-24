/** @fileoverview Unit tests for FireWebhookDispatcher — HTTPS guard, HMAC header, non-2xx error. @module src/workflow-outbox/dispatchers/fire-webhook.dispatcher.spec @author Rajbha Manek */

import { createHmac } from 'crypto';

import { TemplatingService } from '../../workflow-engine/templating/expand';
import {
  FireWebhookDispatcher,
  type FireWebhookPayload,
} from './fire-webhook.dispatcher';

const ORIGINAL_FETCH = global.fetch;

describe('FireWebhookDispatcher', () => {
  let dispatcher: FireWebhookDispatcher;
  let fetchMock: jest.Mock;

  function row(payload: FireWebhookPayload) {
    return {
      id: 'outbox-1',
      organization_id: 'org-1',
      task_id: 'task-1',
      transition_id: 'tx-1',
      payload,
    };
  }

  beforeEach(() => {
    dispatcher = new FireWebhookDispatcher(new TemplatingService());
    fetchMock = jest.fn();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    (global as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  });

  it('rejects non-HTTPS URLs before issuing a request', async () => {
    await expect(
      dispatcher.dispatch(
        row({
          cfg: { url: 'http://example.com/hook' },
          context: {},
        }),
      ),
    ).rejects.toThrow(/must use HTTPS/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets X-Workflow-Signature when a secret is provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const secret = 'super-secret';
    const bodyTemplate = '{"task":"{{task.id}}"}';
    const context = { task: { id: 'task-1' } };
    const expectedBody = '{"task":"task-1"}';
    const expectedSig = createHmac('sha256', secret)
      .update(expectedBody)
      .digest('hex');

    await dispatcher.dispatch(
      row({
        cfg: {
          url: 'https://example.com/hook',
          method: 'POST',
          headers: { 'X-Foo': 'bar' },
          body_template: bodyTemplate,
          secret,
        },
        context,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];

    expect(calledUrl).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Workflow-Signature']).toBe(`sha256=${expectedSig}`);
    expect(init.headers['X-Foo']).toBe('bar');
    expect(init.body).toBe(expectedBody);
  });

  it('falls back to JSON.stringify(context) when body_template is empty', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await dispatcher.dispatch(
      row({
        cfg: { url: 'https://example.com/hook' },
        context: { hello: 'world' },
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.body).toBe('{"hello":"world"}');
  });

  it('throws on a non-2xx response so the processor retries', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      dispatcher.dispatch(
        row({
          cfg: { url: 'https://example.com/hook' },
          context: {},
        }),
      ),
    ).rejects.toThrow(/503/);
  });

  it('does not set a signature header when no secret/secret_ref is provided', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await dispatcher.dispatch(
      row({
        cfg: { url: 'https://example.com/hook' },
        context: {},
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];

    expect(init.headers['X-Workflow-Signature']).toBeUndefined();
  });
});
