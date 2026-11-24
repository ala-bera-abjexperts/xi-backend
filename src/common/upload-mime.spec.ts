import { BadRequestException } from '@nestjs/common';
import {
  assertImageMime,
  assertImageOrVideoMime,
  isImageMime,
  isVideoMime,
  storageContentType,
  normalizeContentType,
  reconcileMimeWithExtension,
  hasKnownDocumentExtension,
} from './upload-mime';

describe('upload-mime', () => {
  describe('isImageMime', () => {
    // The whole point of the rewrite: formats that postdate the old hand-written allow-lists must
    // work without anyone having to remember to add them.
    it.each([
      'image/jpeg',
      'image/png',
      'image/avif',
      'image/heic',
      'image/jxl',
      'image/x-icon',
      'IMAGE/PNG',
    ])('accepts %s', (mime) => {
      expect(isImageMime(mime)).toBe(true);
    });

    it.each(['application/pdf', 'video/mp4', 'text/plain', '', undefined])(
      'rejects %s',
      (mime) => {
        expect(isImageMime(mime)).toBe(false);
      },
    );
  });

  describe('assertImageMime', () => {
    it('accepts SVG where SVG is permitted', () => {
      expect(() =>
        assertImageMime('image/svg+xml', { allowSvg: true }),
      ).not.toThrow();
    });

    it('rejects SVG where SVG is not permitted', () => {
      expect(() =>
        assertImageMime('image/svg+xml', { allowSvg: false }),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-image regardless of the SVG setting', () => {
      expect(() =>
        assertImageMime('application/pdf', { allowSvg: true }),
      ).toThrow(BadRequestException);
    });
  });

  describe('assertImageOrVideoMime', () => {
    it('accepts video codecs the old seven-entry list did not name', () => {
      expect(() =>
        assertImageOrVideoMime('video/x-m4v', { allowSvg: true }),
      ).not.toThrow();
    });

    it('rejects a document', () => {
      expect(() =>
        assertImageOrVideoMime('application/zip', { allowSvg: true }),
      ).toThrow(BadRequestException);
    });
  });

  describe('isVideoMime', () => {
    it('distinguishes video from image', () => {
      expect(isVideoMime('video/webm')).toBe(true);
      expect(isVideoMime('image/webp')).toBe(false);
    });
  });

  describe('storageContentType', () => {
    // Attachments accept every type, but on PUBLIC buckets the stored content type decides whether
    // the browser renders or downloads. Script-capable types must never be stored under their real
    // type, or "attach a file" becomes stored XSS.
    it.each([
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'application/xml',
      'TEXT/HTML',
    ])('neutralises %s to application/octet-stream', (mime) => {
      expect(storageContentType(mime)).toBe('application/octet-stream');
    });

    it.each(['application/pdf', 'image/png', 'application/zip', 'video/mp4'])(
      'passes %s through unchanged',
      (mime) => {
        expect(storageContentType(mime)).toBe(mime);
      },
    );

    it('falls back to octet-stream when the type is missing', () => {
      expect(storageContentType(undefined)).toBe('application/octet-stream');
      expect(storageContentType('')).toBe('application/octet-stream');
    });
  });
});

describe('normalizeContentType', () => {
  it.each([
    ['Application/Vnd.Ms-Excel; charset=UTF-8', 'application/vnd.ms-excel'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [' IMAGE/SVG+XML; charset=utf-8 ', 'image/svg+xml'],
    ['bad content type', 'application/octet-stream'],
    ['text/plain\r\nInjected: yes', 'application/octet-stream'],
    ['text/plain\t', 'application/octet-stream'],
    ['image/*', 'application/octet-stream'],
    ['*/*', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeContentType(input)).toBe(expected);
  });
  it('downgrades parameterized active content on public buckets only', () => {
    expect(storageContentType(' IMAGE/SVG+XML; charset=utf-8 ')).toBe(
      'application/octet-stream',
    );
    expect(normalizeContentType(' IMAGE/SVG+XML; charset=utf-8 ')).toBe(
      'image/svg+xml',
    );
  });
});

describe('reconcileMimeWithExtension', () => {
  it('fixes the real-world failure: a .docx reported as the .dotx template type', () => {
    expect(
      reconcileMimeWithExtension(
        'handbook.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
      ),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('resolves octet-stream to the extension canonical type', () => {
    expect(
      reconcileMimeWithExtension(
        'handbook.docx',
        'application/octet-stream',
      ),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('leaves a correct type untouched', () => {
    expect(
      reconcileMimeWithExtension(
        'handbook.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(reconcileMimeWithExtension('template.dotx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    )).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    );
  });

  it('reconciles the other Office families by extension', () => {
    expect(reconcileMimeWithExtension('book.xlsx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(reconcileMimeWithExtension('old.doc', 'application/octet-stream')).toBe(
      'application/msword',
    );
  });

  it('leaves a foreign concrete type alone', () => {
    expect(reconcileMimeWithExtension('handbook.docx', 'text/plain')).toBe(
      'text/plain',
    );
  });

  it('normalizes source header syntax before comparing', () => {
    expect(
      reconcileMimeWithExtension('handbook.docx', 'TEMPLATE'),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

describe('hasKnownDocumentExtension', () => {
  it('recognizes the office family and common formats', () => {
    expect(hasKnownDocumentExtension('a.docx')).toBe(true);
    expect(hasKnownDocumentExtension('b.PDF')).toBe(true);
    expect(hasKnownDocumentExtension('c.csv')).toBe(true);
  });

  it('rejects unknown or missing extensions', () => {
    expect(hasKnownDocumentExtension('a.weird')).toBe(false);
    expect(hasKnownDocumentExtension('noextension')).toBe(false);
    expect(hasKnownDocumentExtension(undefined)).toBe(false);
  });
});
