/**
 * @fileoverview The storage-key filename sanitiser.
 * @module common/upload-filename.spec
 *
 * Author: Prince Jadiya
 *
 * The first case below is the production incident this exists for: a task
 * attachment named "Änderungsantrag Produktion.zip" produced a storage key with
 * a non-ASCII byte, Supabase Storage rejected it, and the upload failed while
 * leaving a 0-byte row behind in the UI.
 */

import { storageSafeFileName } from './upload-filename';

/**
 * Any byte outside 7-bit ASCII is what Supabase Storage refuses in a key.
 * Expressed as a code-point test rather than a regex range, because the range
 * form trips `no-control-regex` on the \x00 bound.
 */
const NON_ASCII = {
  test: (value: string) => [...value].some((ch) => ch.charCodeAt(0) > 127),
};

describe('storageSafeFileName', () => {
  describe('the production incident', () => {
    it('makes the German filenames that failed in production storable', () => {
      for (const name of [
        'Änderungsantrag Produktion.zip',
        'Änderungsantrag Produktion.xlsm',
        '35_Änderungsantrag.xlsm',
      ]) {
        expect(NON_ASCII.test(storageSafeFileName(name))).toBe(false);
      }
    });

    it('keeps the umlaut readable rather than blanking it', () => {
      // `_nderungsantrag` would also be storable, but the bucket is read by
      // humans during support, so the base letter is worth keeping.
      expect(storageSafeFileName('Änderungsantrag Produktion.zip')).toBe(
        'Anderungsantrag_Produktion.zip',
      );
    });

    it('preserves the extension, which download and sniffing depend on', () => {
      expect(storageSafeFileName('Änderungsantrag Produktion.xlsm')).toMatch(
        /\.xlsm$/,
      );
      expect(storageSafeFileName('35_Änderungsantrag.xlsm')).toMatch(/\.xlsm$/);
    });
  });

  describe('scripts beyond Latin', () => {
    it('handles a name with no ASCII in it at all', () => {
      // CJK does not decompose to base letters, so it sanitises away entirely.
      // The result must still be a usable key, not an empty string.
      const result = storageSafeFileName('文档.pdf');

      expect(NON_ASCII.test(result)).toBe(false);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toMatch(/\.pdf$/);
    });

    it('handles accents that have no base-letter form', () => {
      // ß, ø and æ have no NFD decomposition, so they fall through to `_`.
      expect(NON_ASCII.test(storageSafeFileName('Straße.txt'))).toBe(false);
      expect(NON_ASCII.test(storageSafeFileName('smørrebrød.txt'))).toBe(false);
    });

    it('handles the common European accents', () => {
      expect(storageSafeFileName('résumé.pdf')).toBe('resume.pdf');
      expect(storageSafeFileName('informe año.doc')).toBe('informe_ano.doc');
    });
  });

  describe('never produces an unusable key', () => {
    it('never returns an empty string', () => {
      // An empty segment would leave the key ending in `/`, which is a folder
      // marker, not an object.
      for (const name of ['', '   ', '...', '___', '.', null, undefined]) {
        expect(storageSafeFileName(name).length).toBeGreaterThan(0);
      }
    });

    it('never emits a path separator', () => {
      // A `/` here would silently move the object to another prefix, i.e. into
      // another organization's folder.
      for (const name of [
        'a/b.txt',
        'a\\b.txt',
        '../../etc/passwd',
        '..\\..\\secret.txt',
      ]) {
        expect(storageSafeFileName(name)).not.toMatch(/[/\\]/);
      }
    });

    it('cannot climb out of its prefix', () => {
      expect(storageSafeFileName('../../etc/passwd')).toBe('passwd');
      expect(storageSafeFileName('..')).toBe('file');
    });

    it('does not create a hidden object', () => {
      expect(storageSafeFileName('.env')).not.toMatch(/^\./);
      expect(storageSafeFileName('.gitignore')).not.toMatch(/^\./);
    });

    it('bounds the length', () => {
      const long = `${'a'.repeat(500)}.pdf`;
      const result = storageSafeFileName(long);

      expect(result.length).toBeLessThanOrEqual(120);
      expect(result).toMatch(/\.pdf$/);
    });
  });

  describe('leaves ordinary names alone', () => {
    it('passes through a plain ASCII name unchanged', () => {
      // The overwhelming majority of uploads. If this ever changes, every
      // existing key convention changes with it.
      for (const name of [
        'Nahtstellenbewertung 1_Kopie 08.06.2026.xlsx',
        'report.pdf',
        'my-file_v2.PNG',
      ]) {
        expect(NON_ASCII.test(storageSafeFileName(name))).toBe(false);
      }

      expect(storageSafeFileName('report.pdf')).toBe('report.pdf');
      expect(storageSafeFileName('my-file_v2.PNG')).toBe('my-file_v2.PNG');
    });

    it('keeps a name that has no extension', () => {
      expect(storageSafeFileName('README')).toBe('README');
    });

    it('collapses runs of separators rather than stacking them', () => {
      expect(storageSafeFileName('a    b.txt')).toBe('a_b.txt');
    });

    it('is idempotent', () => {
      // Re-uploading a version must land on the same shape, not accumulate
      // substitutions.
      for (const name of [
        'Änderungsantrag Produktion.zip',
        '文档.pdf',
        '.env',
      ]) {
        const once = storageSafeFileName(name);

        expect(storageSafeFileName(once)).toBe(once);
      }
    });
  });

  describe('European-customer edge cases', () => {
    it('treats NFD-decomposed input (macOS filenames) the same as precomposed', () => {
      // macOS stores "Ä" as A + combining diaeresis. Both forms must fold to the same key.
      const decomposed = 'Änderung.pdf'; // NFD
      const precomposed = 'Änderung.pdf'; // NFC

      expect(storageSafeFileName(decomposed)).toBe('Anderung.pdf');
      expect(storageSafeFileName(decomposed)).toBe(
        storageSafeFileName(precomposed),
      );
    });

    it('handles Cyrillic and Greek (no decomposition) via the fallback base', () => {
      // Cyrillic/Greek letters have no NFD base-letter decomposition, so they sanitise away
      // entirely — the fallback must keep the key non-empty with the extension intact.
      expect(storageSafeFileName('Отчёт.pdf')).toBe('file.pdf');
      expect(storageSafeFileName('Έκθεση.docx')).toBe('file.docx');
    });

    it('caps an over-long extension', () => {
      const name = `report.${'x'.repeat(30)}`;
      const out = storageSafeFileName(name);
      const extension = out.split('.').pop() ?? '';

      expect(extension.length).toBeLessThanOrEqual(16);
      expect(NON_ASCII.test(out)).toBe(false);
    });

    it('handles astral-plane characters (emoji) without breaking the name', () => {
      const out = storageSafeFileName('📄 Bericht Q3.pdf');

      expect(NON_ASCII.test(out)).toBe(false);
      expect(out).toContain('Bericht');
      expect(out.endsWith('.pdf')).toBe(true);
    });
  });
});
