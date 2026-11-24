import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { MultipartEncodingModule } from './multipart-encoding.module';

/**
 * Proves the fix through REAL multer + busboy, not by asserting the option value.
 *
 * multer@2 defaults `defParamCharset` to latin1, so the UTF-8 bytes of `ü` (0xC3 0xBC) come back as
 * the two characters `Ã¼`. The name below is the one from the bug report.
 */
const GERMAN_NAME = 'Mag Eckschlager Gründung XISUITE GmbH.pdf';
const MOJIBAKE = 'Mag Eckschlager GrÃ¼ndung XISUITE GmbH.pdf';

@Controller('probe')
class ProbeController {
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File) {
    return { originalname: file?.originalname };
  }
}

async function bootstrap(withFix: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    // Without the fix, no MULTER_MODULE_OPTIONS provider exists at all — the interceptor's
    // @Optional() injection yields {} and multer falls back to latin1. That is the pre-fix state.
    imports: withFix ? [MultipartEncodingModule] : [MulterModule.register({})],
    controllers: [ProbeController],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();

  await app.init();

  return app;
}

describe('MultipartEncodingModule', () => {
  it('decodes a non-ASCII multipart filename as UTF-8', async () => {
    const app = await bootstrap(true);

    try {
      const res = await request(app.getHttpServer())
        .post('/probe/upload')
        .attach('file', Buffer.from('%PDF-1.4 test'), {
          filename: GERMAN_NAME,
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(201);
      expect(res.body.originalname).toBe(GERMAN_NAME);
      expect(res.body.originalname).not.toContain('Ã');
    } finally {
      await app.close();
    }
  });

  it('reproduces the latin1 mojibake WITHOUT the module, pinning what regressed', async () => {
    const app = await bootstrap(false);

    try {
      const res = await request(app.getHttpServer())
        .post('/probe/upload')
        .attach('file', Buffer.from('%PDF-1.4 test'), {
          filename: GERMAN_NAME,
          contentType: 'application/pdf',
        });

      expect(res.status).toBe(201);
      expect(res.body.originalname).toBe(MOJIBAKE);
    } finally {
      await app.close();
    }
  });

  it('leaves a plain ASCII filename untouched', async () => {
    const app = await bootstrap(true);

    try {
      const res = await request(app.getHttpServer())
        .post('/probe/upload')
        .attach('file', Buffer.from('x'), {
          filename: 'invoice-2026.pdf',
          contentType: 'application/pdf',
        });

      expect(res.body.originalname).toBe('invoice-2026.pdf');
    } finally {
      await app.close();
    }
  });

  it('handles emoji and CJK filenames, not just latin-1 accents', async () => {
    const app = await bootstrap(true);

    try {
      for (const filename of ['отчёт.pdf', '報告書.pdf', 'Bericht 🗓.pdf']) {
        const res = await request(app.getHttpServer())
          .post('/probe/upload')
          .attach('file', Buffer.from('x'), {
            filename,
            contentType: 'application/pdf',
          });

        expect(res.body.originalname).toBe(filename);
      }
    } finally {
      await app.close();
    }
  });
});
