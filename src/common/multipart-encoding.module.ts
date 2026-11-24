import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

/**
 * `defParamCharset` is a genuine multer option — `multer/index.js` reads it and forwards it to
 * busboy, and `@types/multer@2.1.0` declares it — but Nest's own `MulterOptions` interface
 * redeclares only a SUBSET of multer's options and omits this one. The cast records exactly that
 * typings gap; it is not widening the option object.
 */
const UTF8_FILENAMES = { defParamCharset: 'utf8' } as MulterOptions;

/**
 * Forces multipart field/filename decoding to UTF-8 for every upload in the app.
 *
 * WHY THIS EXISTS
 *   `multer@2` defaults `defParamCharset` to **latin1** (`multer/index.js`:
 *   `this.defParamCharset = options.defParamCharset || 'latin1'`) and forwards it to busboy. Every
 *   non-ASCII filename therefore arrives mojibaked in `file.originalname`: the UTF-8 bytes of `ü`
 *   (0xC3 0xBC) get decoded as two latin1 characters, so
 *
 *     "Mag Eckschlager Gründung XISUITE GmbH.pdf"
 *
 *   is read as
 *
 *     "Mag Eckschlager GrÃ¼ndung XISUITE GmbH.pdf"
 *
 *   and that is what ~20 services persist into their `file_name` column and show back to the user.
 *
 * WHY IT IS GLOBAL RATHER THAN PER-INTERCEPTOR
 *   `FileInterceptor` merges `{ ...MULTER_MODULE_OPTIONS, ...localOptions }`, so a single global
 *   options provider fixes every `FileInterceptor` / `FilesInterceptor` / `AnyFilesInterceptor` /
 *   `FileFieldsInterceptor` in the codebase at once — over fifty call sites, none of which need to
 *   know about this. `MulterModule` is NOT `@Global` and the interceptor's injection is `@Optional()`,
 *   which is why the token silently resolved to `{}` (and thus latin1) before: re-exporting it from a
 *   `@Global` module is what actually makes it visible app-wide.
 *
 *   A local `MulterModule.register(...)` in a feature module still wins for that module, and any
 *   `localOptions` passed to an interceptor still override these — this only changes the default.
 *
 * SCOPE
 *   This corrects the DECODED FILENAME only. Storage object keys stay ASCII-sanitised at each call
 *   site (`replace(/[^a-zA-Z0-9._-]/g, '_')`), which is deliberate: the key must survive URL and
 *   bucket constraints, while the display name in the database keeps the real characters.
 */
@Global()
@Module({
  imports: [MulterModule.register(UTF8_FILENAMES)],
  exports: [MulterModule],
})
export class MultipartEncodingModule {}
