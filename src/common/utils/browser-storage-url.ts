/**
 * Local Supabase serves storage over plain HTTP. Returning its absolute URL to an HTTPS browser
 * causes the browser to block migrated images as mixed content. Keep production URLs untouched;
 * local URLs become same-origin paths handled by the frontend's local storage rewrite.
 */
export function browserSafeStorageUrl(
  publicUrl: string,
  storageBase = process.env.SUPABASE_URL ?? '',
): string {
  try {
    const storage = new URL(storageBase);
    const url = new URL(publicUrl);
    const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(
      storage.hostname,
    );

    if (
      storage.protocol === 'http:' &&
      localHost &&
      url.origin === storage.origin &&
      url.pathname.startsWith('/storage/v1/')
    ) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // Keep the provider URL when configuration or the returned value is malformed.
  }

  return publicUrl;
}
