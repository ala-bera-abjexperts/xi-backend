type Json = Record<string, unknown>;

const BLOCK = 512;

// The files of a docker save that name the image. A load would apply those names and could replace images
// of this machine, such as the built-in runner images, so they are rewritten without names or left out.
export const NAMING_FILES = new Set([
  'manifest.json',
  'index.json',
  'repositories',
]);

const NAME_ANNOTATIONS = [
  'org.opencontainers.image.ref.name',
  'io.containerd.image.name',
];

export const TAR_END = Buffer.alloc(BLOCK * 2);

export function isAttestation(entry: Json): boolean {
  const annotations = entry.annotations as Json | undefined;

  // Docker Desktop's own image store marks it only by the image it belongs to.
  return (
    annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' ||
    typeof annotations?.['io.containerd.manifest.subject'] === 'string'
  );
}

/** The one manifest.json entry without its RepoTags. */
export function cleanManifest(entry: Json): Json[] {
  const rest = { ...entry };

  delete rest.RepoTags;

  return [rest];
}

/** index.json with only the image entry, and without the annotations that name it. */
export function cleanIndex(index: Json, entry: Json): Json {
  const annotations = { ...((entry.annotations as Json | undefined) ?? {}) };

  for (const name of NAME_ANNOTATIONS) delete annotations[name];

  const rest = { ...entry };

  delete rest.annotations;

  return {
    ...index,
    manifests: [
      Object.keys(annotations).length > 0 ? { ...rest, annotations } : rest,
    ],
  };
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

// The largest size an 11-digit octal size field holds.
export const TAR_MAX_FILE_BYTES = 0o77777777777;

/** The header of one plain file whose content is written after it, then padded with tarPadding. */
export function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error('Tar name too long');
  if (!Number.isInteger(size) || size < 0 || size > TAR_MAX_FILE_BYTES) {
    throw new Error('Tar file too large');
  }

  const header = Buffer.alloc(BLOCK);

  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(0, 12), 136, 'ascii');
  header.write(' '.repeat(8), 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');

  const sum = header.reduce((total, byte) => total + byte, 0);

  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  return header;
}

/** Zeros that fill a file of this size up to whole blocks. */
export function tarPadding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** One plain file of a ustar archive: its header and its content padded to whole blocks. */
export function tarFile(name: string, content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error('Tar name too long');

  const header = Buffer.alloc(BLOCK);

  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(content.length, 12), 124, 'ascii');
  header.write(octal(0, 12), 136, 'ascii');
  header.write(' '.repeat(8), 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');

  const sum = header.reduce((total, byte) => total + byte, 0);

  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;

  return Buffer.concat([header, content, Buffer.alloc(padding)]);
}
