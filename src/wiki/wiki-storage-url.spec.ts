import { browserSafeStorageUrl } from './wiki.service';

describe('browserSafeStorageUrl', () => {
  it('keeps signed query parameters and only rewrites the configured local storage origin', () => {
    expect(
      browserSafeStorageUrl(
        'http://[::1]:54321/storage/v1/object/sign/a?token=test&download=a.jpg',
        'http://[::1]:54321',
      ),
    ).toBe('/storage/v1/object/sign/a?token=test&download=a.jpg');
    for (const url of [
      'http://foreign.test/storage/v1/a',
      'http://localhost:54322/storage/v1/a',
      'http://localhost:54321/auth/v1/a',
      'not-a-url',
    ]) {
      expect(browserSafeStorageUrl(url, 'http://localhost:54321')).toBe(url);
    }
  });

  it('uses a same-origin path for local HTTP storage and preserves production URLs', () => {
    expect(
      browserSafeStorageUrl(
        'http://127.0.0.1:54321/storage/v1/object/public/wiki-attachments/a.png',
        'http://127.0.0.1:54321',
      ),
    ).toBe('/storage/v1/object/public/wiki-attachments/a.png');
    expect(
      browserSafeStorageUrl(
        'https://project.supabase.co/storage/v1/object/public/wiki-attachments/a.png',
        'https://project.supabase.co',
      ),
    ).toBe(
      'https://project.supabase.co/storage/v1/object/public/wiki-attachments/a.png',
    );
  });
});
