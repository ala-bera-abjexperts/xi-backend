/* eslint-disable @typescript-eslint/unbound-method */
// (grabbing `puppeteer.launch` as a jest.Mock is a known unbound-method false
// positive — same disable used by the controller specs)

// Puppeteer is mocked module-level — these specs exercise the service's
// semaphore, lifecycle, and interception wiring, never a real browser.
jest.mock('puppeteer', () => ({
  __esModule: true,
  default: { launch: jest.fn() },
}));

import puppeteer from 'puppeteer';
import type { ConfigService } from '@nestjs/config';
import { PdfRenderService } from './pdf-render.service';

const launchMock = puppeteer.launch as jest.Mock;

type WithLoadPuppeteer = { loadPuppeteer: () => Promise<unknown> };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface MockPage {
  setRequestInterception: jest.Mock;
  on: jest.Mock;
  setContent: jest.Mock;
  waitForNetworkIdle: jest.Mock;
  evaluate: jest.Mock;
  pdf: jest.Mock;
}

function createBrowserMock(pdfImpl?: () => Promise<Uint8Array>) {
  const pages: MockPage[] = [];
  const contexts: Array<{ newPage: jest.Mock; close: jest.Mock }> = [];

  const browser = {
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    createBrowserContext: jest.fn(() => {
      const page: MockPage = {
        setRequestInterception: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        setContent: jest.fn().mockResolvedValue(undefined),
        waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue(undefined),
        pdf: pdfImpl
          ? jest.fn(pdfImpl)
          : jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      };
      pages.push(page);

      const context = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      contexts.push(context);

      return Promise.resolve(context);
    }),
  };

  return { browser, pages, contexts };
}

function configMock(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn(
      (key: string) =>
        values[key] ??
        (key === 'supabase.url' ? 'https://proj.supabase.co' : undefined),
    ),
  } as unknown as ConfigService;
}

const PAGE = { widthPx: 794, heightPx: 1123 };

describe('PdfRenderService', () => {
  let loadSpy: jest.SpyInstance;

  beforeEach(() => {
    launchMock.mockReset();

    // The service loads puppeteer via a NATIVE dynamic import() (kept as-is
    // by tsc under module nodenext — that is the whole point of the lazy-boot
    // fix). Jest's VM cannot service native import() without
    // --experimental-vm-modules, so specs stub the loader seam to hand back
    // the module mock; production resolves the real ESM package.
    loadSpy = jest
      .spyOn(
        PdfRenderService.prototype as unknown as WithLoadPuppeteer,
        'loadPuppeteer',
      )
      .mockResolvedValue(puppeteer);
  });

  afterEach(() => {
    loadSpy.mockRestore();
  });

  it('returns a Buffer from the rendered pdf', async () => {
    const { browser } = createBrowserMock();
    launchMock.mockResolvedValue(browser);
    const service = new PdfRenderService(configMock());

    const result = await service.renderPdf('<html></html>', PAGE);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(3);
  });

  it('caps concurrency at DOCUMENT_PDF_CONCURRENCY — the 3rd render waits', async () => {
    const gates: Array<Deferred<Uint8Array>> = [];
    const { browser } = createBrowserMock(() => {
      const gate = deferred<Uint8Array>();
      gates.push(gate);

      return gate.promise;
    });
    launchMock.mockResolvedValue(browser);
    const service = new PdfRenderService(configMock());

    const first = service.renderPdf('<html>1</html>', PAGE);
    const second = service.renderPdf('<html>2</html>', PAGE);
    const third = service.renderPdf('<html>3</html>', PAGE);
    await flush();

    // Default concurrency is 2 — only two renders may have opened a context.
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(2);

    gates[0].resolve(new Uint8Array([1]));
    await flush();

    // Slot freed → the queued third render proceeds.
    expect(browser.createBrowserContext).toHaveBeenCalledTimes(3);

    gates[1].resolve(new Uint8Array([2]));
    gates[2].resolve(new Uint8Array([3]));
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });

  it('rejects with 429 when the waiting queue is full', async () => {
    const gates: Array<Deferred<Uint8Array>> = [];
    const { browser } = createBrowserMock(() => {
      const gate = deferred<Uint8Array>();
      gates.push(gate);

      return gate.promise;
    });
    launchMock.mockResolvedValue(browser);
    const service = new PdfRenderService(
      configMock({ DOCUMENT_PDF_CONCURRENCY: '1' }),
    );

    // 1 active + 10 queued fills every slot; the 12th call must 429.
    const pending = Array.from({ length: 11 }, (_, i) =>
      service.renderPdf(`<html>${i}</html>`, PAGE),
    );
    await flush();

    await expect(
      service.renderPdf('<html>x</html>', PAGE),
    ).rejects.toMatchObject({ status: 429 });

    for (let i = 0; i < pending.length; i++) {
      gates[i]?.resolve(new Uint8Array([i]));
      await flush();
    }
    await Promise.all(pending);
  });

  it('throws 501 without importing or launching when DOCUMENT_PDF_ENABLED=false', async () => {
    const service = new PdfRenderService(
      configMock({ DOCUMENT_PDF_ENABLED: 'false' }),
    );

    await expect(
      service.renderPdf('<html></html>', PAGE),
    ).rejects.toMatchObject({ status: 501 });
    // puppeteer is loaded lazily via dynamic import (ESM-only package with a
    // Node >=22.12 floor) — a disabled deployment must never attempt it.
    expect(loadSpy).not.toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('maps a failed puppeteer import to the 501 unavailable path', async () => {
    const service = new PdfRenderService(configMock());
    loadSpy.mockRejectedValue(new Error('ERR_REQUIRE_ESM'));

    await expect(
      service.renderPdf('<html></html>', PAGE),
    ).rejects.toMatchObject({ status: 501 });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('retries a failed launch once, then throws 501', async () => {
    launchMock.mockRejectedValue(new Error('no chrome binary'));
    const service = new PdfRenderService(configMock());

    const rejection = expect(
      service.renderPdf('<html></html>', PAGE),
    ).rejects.toMatchObject({ status: 501 });
    await rejection;

    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the launch retry succeeds', async () => {
    const { browser } = createBrowserMock();
    launchMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(browser);
    const service = new PdfRenderService(configMock());

    const result = await service.renderPdf('<html></html>', PAGE);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('configures request interception allowing only data:/about:/supabase host', async () => {
    const { browser, pages } = createBrowserMock();
    launchMock.mockResolvedValue(browser);
    const service = new PdfRenderService(configMock());

    await service.renderPdf('<html></html>', PAGE);

    const page = pages[0];
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);

    const onCalls = page.on.mock.calls as Array<[string, unknown]>;
    const handlerEntry = onCalls.find(([event]) => event === 'request');
    expect(handlerEntry).toBeDefined();
    const handler = handlerEntry![1] as (request: {
      url: () => string;
      continue: jest.Mock;
      abort: jest.Mock;
    }) => void;

    const request = (url: string) => ({
      url: () => url,
      continue: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    });

    const dataReq = request('data:image/png;base64,AAAA');
    handler(dataReq);
    expect(dataReq.continue).toHaveBeenCalled();

    const supabaseReq = request(
      'https://proj.supabase.co/storage/v1/object/sign/x',
    );
    handler(supabaseReq);
    expect(supabaseReq.continue).toHaveBeenCalled();

    const evilReq = request('https://evil.example.com/exfil');
    handler(evilReq);
    expect(evilReq.abort).toHaveBeenCalled();
    expect(evilReq.continue).not.toHaveBeenCalled();
  });

  it('closes the browser context even when rendering fails', async () => {
    const { browser, contexts } = createBrowserMock();
    launchMock.mockResolvedValue(browser);
    const boom = new Error('render exploded');

    // Page whose setContent throws mid-render.
    browser.createBrowserContext.mockImplementationOnce(() => {
      const page = {
        setRequestInterception: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        setContent: jest.fn().mockRejectedValue(boom),
        waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
        pdf: jest.fn(),
      };
      const context = {
        newPage: jest.fn().mockResolvedValue(page),
        close: jest.fn().mockResolvedValue(undefined),
      };
      contexts.push(context);

      return Promise.resolve(context);
    });

    const service = new PdfRenderService(configMock());

    await expect(service.renderPdf('<html></html>', PAGE)).rejects.toBe(boom);
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it('closes the singleton browser on module destroy', async () => {
    const { browser } = createBrowserMock();
    launchMock.mockResolvedValue(browser);
    const service = new PdfRenderService(configMock());

    await service.renderPdf('<html></html>', PAGE);
    await service.onModuleDestroy();

    expect(browser.close).toHaveBeenCalled();
  });
});
