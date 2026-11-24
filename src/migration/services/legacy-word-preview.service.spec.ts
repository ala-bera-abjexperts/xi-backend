import {
  isLegacyWordDocument,
  LegacyWordPreviewService,
} from './legacy-word-preview.service';

describe('LegacyWordPreviewService', () => {
  it.each(['source.doc', 'SOURCE.DOC', 'source.doc '])('recognises legacy Word names: %s', (name) => {
    expect(isLegacyWordDocument(name)).toBe(true);
  });

  it.each(['source.docx', 'source.pdf'])(
    'does not treat %s as legacy Word',
    (name) => {
      expect(isLegacyWordDocument(name)).toBe(false);
    },
  );

  it('rejects invalid DOC bytes before it can start a converter process', async () => {
    await expect(new LegacyWordPreviewService().convert(Buffer.from('not-doc'))).rejects.toThrow(
      'invalid DOC signature',
    );
  });
});
