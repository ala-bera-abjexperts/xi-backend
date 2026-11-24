import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  isAllowedTemplateImageSource,
  ALLOWED_TEMPLATE_IMAGE_BUCKETS,
} from '../document-exports.constants';
import type {
  DocImageSrc,
  IDocumentTemplateDefinition,
} from '../template-definition/template-definition.types';
import type { IDocxImageData } from './docx-render.service';

const SIGNED_IMAGE_URL_TTL_SECONDS = 300;

/** Largest storage image embedded in a Word export. */
const MAX_DOCX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Word's ImageRun formats, sniffed from the file's magic bytes. */
function docxImageType(data: Buffer): IDocxImageData['type'] | null {
  if (data.length < 4) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif';
  // "BM" alone is too weak — the header also stores the file size.
  if (
    data.length >= 26 &&
    data[0] === 0x42 &&
    data[1] === 0x4d &&
    data.readUInt32LE(2) === data.length
  ) {
    return 'bmp';
  }

  return null;
}

/**
 * Pre-resolves image sources for the html/pdf render path: storage images
 * become 300 s signed URLs (async, done up front — the render hook is sync);
 * url images are blanked unless DOCUMENT_DESIGNER_ALLOW_REMOTE_IMAGES=true.
 * Shared by both the export pipeline and the editor's live preview, so the
 * two never disagree about whether a storage image renders.
 */
@Injectable()
export class DocumentImageResolverService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Signs a deduped batch of storage bucket/path pairs. Disallowed (outside
   * `ALLOWED_TEMPLATE_IMAGE_BUCKETS`/the org's own folder) or failed-to-sign
   * entries map to '' rather than being omitted, so callers can distinguish
   * "not resolved yet" from "resolved to nothing".
   */
  async signMany(
    organizationId: string,
    images: readonly { bucket: string; path: string }[],
  ): Promise<Record<string, string>> {
    const signedByKey = new Map<string, string>();

    await Promise.all(
      images.map(async (src) => {
        const key = `${src.bucket}/${src.path}`;
        if (signedByKey.has(key)) return;

        // this.client is service-role and bypasses storage policies — never
        // sign a bucket/path outside the allowlist + the org's own folder
        // (the stored definition is user-authored and must not be trusted).
        if (!isAllowedTemplateImageSource(organizationId, src)) {
          signedByKey.set(key, '');
          return;
        }

        const { data, error } = await this.client.storage
          .from(src.bucket)
          .createSignedUrl(src.path, SIGNED_IMAGE_URL_TTL_SECONDS);

        signedByKey.set(key, error || !data?.signedUrl ? '' : data.signedUrl);
      }),
    );

    return Object.fromEntries(signedByKey);
  }

  async prepareImages(
    organizationId: string,
    definition: IDocumentTemplateDefinition,
    warnings: string[],
  ): Promise<{
    definition: IDocumentTemplateDefinition;
    resolveImageSrc: (src: DocImageSrc) => string;
  }> {
    const allowRemote =
      (
        this.configService.get<string>(
          'DOCUMENT_DESIGNER_ALLOW_REMOTE_IMAGES',
        ) ?? 'false'
      ).toLowerCase() === 'true';

    const storageSrcs: { bucket: string; path: string }[] = [];
    for (const el of definition.elements) {
      if (el.type === 'image' && el.src.kind === 'storage') {
        storageSrcs.push({ bucket: el.src.bucket, path: el.src.path });
      }
    }

    // this.client (inside signMany) is service-role and bypasses storage
    // policies — signMany never signs a bucket/path outside the allowlist +
    // the org's own folder (the stored definition is user-authored and must
    // not be trusted).
    const signedByKey = new Map(
      Object.entries(await this.signMany(organizationId, storageSrcs)),
    );
    const signFailureWarned = new Set<string>();
    let mutated = false;

    const elements = definition.elements.map((el) => {
      if (el.type !== 'image') return el;

      if (el.src.kind === 'url') {
        if (allowRemote) return el;
        warnings.push(
          `Image element ${el.id}: remote URL images are disabled (DOCUMENT_DESIGNER_ALLOW_REMOTE_IMAGES)`,
        );
        mutated = true;

        return { ...el, src: { kind: 'url' as const, url: '' } };
      }

      if (el.src.kind === 'storage') {
        const key = `${el.src.bucket}/${el.src.path}`;

        if (!isAllowedTemplateImageSource(organizationId, el.src)) {
          warnings.push(
            `Image element ${el.id}: storage image outside the organization's allowed buckets (${ALLOWED_TEMPLATE_IMAGE_BUCKETS.join(', ')}) — rendered empty`,
          );
        } else if (!signedByKey.get(key) && !signFailureWarned.has(key)) {
          signFailureWarned.add(key);
          warnings.push(
            `Image element ${el.id}: storage image could not be signed (rendered empty)`,
          );
        }
      }

      return el;
    });

    return {
      definition: mutated ? { ...definition, elements } : definition,
      resolveImageSrc: (src: DocImageSrc) => {
        if (src.kind !== 'storage') return '';

        return signedByKey.get(`${src.bucket}/${src.path}`) ?? '';
      },
    };
  }

  /**
   * DOCX export: downloads the template's storage image elements so Word can
   * embed them (the PDF path signs URLs instead). Same allowlist + own-folder
   * check as signMany; undefined when the template has no storage images.
   */
  async downloadForDocx(
    organizationId: string,
    definition: IDocumentTemplateDefinition,
    warnings: string[],
  ): Promise<Map<string, IDocxImageData> | undefined> {
    const sources = new Map<string, { bucket: string; path: string }>();
    for (const el of definition.elements) {
      if (el.type === 'image' && el.src.kind === 'storage') {
        sources.set(`${el.src.bucket}/${el.src.path}`, {
          bucket: el.src.bucket,
          path: el.src.path,
        });
      }
    }
    if (sources.size === 0) return undefined;

    const images = new Map<string, IDocxImageData>();
    await Promise.all(
      Array.from(sources.entries()).map(async ([key, src]) => {
        // this.client is service-role — never read outside the org's own folder.
        if (!isAllowedTemplateImageSource(organizationId, src)) {
          warnings.push(
            `Storage image ${key}: outside the organization's allowed buckets (${ALLOWED_TEMPLATE_IMAGE_BUCKETS.join(', ')}) — not embedded in Word`,
          );
          return;
        }

        try {
          const { data, error } = await this.client.storage
            .from(src.bucket)
            .download(src.path);
          if (error || !data) {
            warnings.push(
              `Storage image ${key}: could not be downloaded — not embedded in Word`,
            );
            return;
          }
          // Check the size before buffering the whole file.
          if (data.size > MAX_DOCX_IMAGE_BYTES) {
            warnings.push(
              `Storage image ${key}: larger than 10 MB — not embedded in Word`,
            );
            return;
          }
          const buffer = Buffer.from(await data.arrayBuffer());
          if (buffer.length > MAX_DOCX_IMAGE_BYTES) {
            warnings.push(
              `Storage image ${key}: larger than 10 MB — not embedded in Word`,
            );
            return;
          }
          const type = docxImageType(buffer);
          if (!type) {
            warnings.push(
              `Storage image ${key}: only PNG, JPEG, GIF or BMP can be embedded in Word (skipped)`,
            );
            return;
          }
          images.set(key, { type, data: buffer });
        } catch {
          warnings.push(
            `Storage image ${key}: could not be downloaded — not embedded in Word`,
          );
        }
      }),
    );

    return images;
  }
}
