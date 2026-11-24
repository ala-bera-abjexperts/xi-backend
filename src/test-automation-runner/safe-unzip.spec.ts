import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deflateRawSync } from 'zlib';

import { safeUnzip, UnzipError } from './safe-unzip';

interface FakeFile {
  name: string;
  content?: string;
  // Lets a zip claim a size that is not the real one.
  claimedSize?: number;
  mode?: number;
  // Stored bytes that are not valid compressed data.
  raw?: Buffer;
}

/** A real zip, built by hand because the usual tools refuse to write dangerous or lying ones. */
function zipOf(files: FakeFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const plain = Buffer.from(file.content ?? '', 'utf8');
    const data = file.raw ?? deflateRawSync(plain);
    const size = file.claimedSize ?? plain.length;
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((file.mode ?? 0o100755) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

describe('safeUnzip', () => {
  let folder: string;

  const problemOf = async (
    buffer: Buffer,
    maxBytes?: number,
  ): Promise<string> => {
    const error: unknown = await safeUnzip(buffer, folder, maxBytes).then(
      () => {
        throw new Error('Expected the zip to be refused');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(UnzipError);

    return (error as UnzipError).problem;
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'safe-unzip-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('unpacks files, nested folders and hidden files', async () => {
    await safeUnzip(
      zipOf([
        { name: 'src/' },
        { name: 'src/tests/login.spec.ts', content: 'test login' },
        { name: '.env.test', content: 'A=1' },
        { name: 'package.json', content: '{}' },
      ]),
      folder,
    );

    expect(readFileSync(join(folder, 'src/tests/login.spec.ts'), 'utf8')).toBe(
      'test login',
    );
    expect(readFileSync(join(folder, '.env.test'), 'utf8')).toBe('A=1');
    expect(lstatSync(join(folder, 'src')).isDirectory()).toBe(true);
  });

  it('keeps only the execute bit, whatever mode the zip asks for', async () => {
    await safeUnzip(
      zipOf([{ name: 'run.sh', content: 'echo', mode: 0o104777 }]),
      folder,
    );

    expect(lstatSync(join(folder, 'run.sh')).mode & 0o7777).toBe(0o755);
  });

  it.each([
    ['an ordinary file', 0o100644],
    ['a file only others may run', 0o100601],
    ['a zip from a system with no modes', 0],
  ])('leaves %s plain', async (_, mode) => {
    await safeUnzip(zipOf([{ name: 'a.txt', content: 'x', mode }]), folder);

    expect(lstatSync(join(folder, 'a.txt')).mode & 0o7777).toBe(0o644);
  });

  it('unpacks an empty zip to nothing', async () => {
    await expect(safeUnzip(zipOf([]), folder)).resolves.toBeUndefined();
  });

  it.each(['../evil.txt', 'a/../../evil.txt', '/etc/evil.txt', 'a\\b.txt'])(
    'refuses %s and writes nothing',
    async (name) => {
      await expect(
        problemOf(
          zipOf([
            { name: 'first.txt', content: 'x' },
            { name, content: 'evil' },
          ]),
        ),
      ).resolves.toBe('UNSAFE_PATH');
      expect(existsSync(join(folder, 'first.txt'))).toBe(false);
      expect(existsSync(join(folder, '..', 'evil.txt'))).toBe(false);
    },
  );

  it('refuses a symbolic link and writes nothing', async () => {
    await expect(
      problemOf(zipOf([{ name: 'link', content: '/etc', mode: 0o120777 }])),
    ).resolves.toBe('SYMLINK');
    expect(existsSync(join(folder, 'link'))).toBe(false);
  });

  it('refuses a file that is not a zip', async () => {
    await expect(problemOf(Buffer.from('not a zip'))).resolves.toBe(
      'NOT_A_ZIP',
    );
  });

  it('refuses a zip whose content is larger than it claims', async () => {
    await expect(
      problemOf(
        zipOf([
          { name: 'bomb.bin', content: 'x'.repeat(5000), claimedSize: 5 },
        ]),
      ),
    ).resolves.toBe('NOT_A_ZIP');
  });

  it('refuses a zip whose content is smaller than it claims', async () => {
    await expect(
      problemOf(zipOf([{ name: 'a.bin', content: 'x', claimedSize: 500 }])),
    ).resolves.toBe('NOT_A_ZIP');
  });

  it('refuses broken compressed data', async () => {
    await expect(
      problemOf(
        zipOf([
          {
            name: 'a.txt',
            raw: Buffer.from([0xff, 0xff, 0xff, 0xff]),
            claimedSize: 10,
          },
        ]),
      ),
    ).resolves.toBe('NOT_A_ZIP');
  });

  it('counts the real bytes of all files against the limit', async () => {
    const files = [
      { name: 'a.bin', content: 'x'.repeat(600) },
      { name: 'b.bin', content: 'y'.repeat(600) },
    ];

    await expect(problemOf(zipOf(files), 1000)).resolves.toBe(
      'TOO_LARGE_UNPACKED',
    );
    expect(lstatSync(join(folder, 'a.bin')).size).toBe(600);
  });

  it('accepts exactly the limit', async () => {
    await expect(
      safeUnzip(
        zipOf([{ name: 'a.bin', content: 'x'.repeat(1000) }]),
        folder,
        1000,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a repeated name instead of overwriting the first file', async () => {
    await expect(
      problemOf(
        zipOf([
          { name: 'a.txt', content: 'first' },
          { name: 'a.txt', content: 'second' },
        ]),
      ),
    ).resolves.toBe('UNSAFE_PATH');
    expect(readFileSync(join(folder, 'a.txt'), 'utf8')).toBe('first');
  });

  it('refuses a file and a folder with the same name', async () => {
    await expect(
      problemOf(
        zipOf([
          { name: 'a', content: 'file' },
          { name: 'a/b.txt', content: 'nested' },
        ]),
      ),
    ).resolves.toBe('UNSAFE_PATH');
  });

  it('does not blame the zip for a problem of this machine', async () => {
    chmodSync(folder, 0o555);

    try {
      const error: unknown = await safeUnzip(
        zipOf([{ name: 'a.txt', content: 'x' }]),
        folder,
      ).catch((reason: unknown) => reason);

      expect(error).not.toBeInstanceOf(UnzipError);
      expect(error).toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(folder, 0o755);
    }
  });
});
