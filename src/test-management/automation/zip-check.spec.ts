import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import { deflateRawSync } from 'zlib';

import { AUTOMATION_LIMITS } from './automation-inputs';
import { checkZip } from './zip-check';
import {
  collidesWith,
  listZipFiles,
  readZipFile,
  rebuildZip,
  ZipFileError,
} from './zip-files';

interface FakeEntry {
  name: string;
  // Unix file type and mode, kept in the high word of the external attributes.
  mode?: number;
  unpackedSize?: number;
}

/** A zip's table of contents only; checkZip never reads the file contents. */
function zipOf(entries: FakeEntry[]): Buffer {
  const central: Buffer[] = [];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(entry.unpackedSize ?? 1, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.push(header, name);
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);

  return Buffer.concat([directory, end]);
}

describe('checkZip', () => {
  it('accepts a normal project, hidden files included', async () => {
    await expect(
      checkZip(
        zipOf([
          { name: 'src/' },
          { name: 'src/login.spec.ts' },
          { name: '.github/ci.yml' },
          { name: 'package.json' },
        ]),
      ),
    ).resolves.toBeNull();
  });

  it('accepts an empty zip', async () => {
    await expect(checkZip(zipOf([]))).resolves.toBeNull();
  });

  it.each(['not a zip', ''])('refuses %j as not a zip', async (text) => {
    await expect(checkZip(Buffer.from(text))).resolves.toBe('NOT_A_ZIP');
  });

  it.each([
    '../evil.txt',
    'a/../../evil.txt',
    '/etc/evil.txt',
    'C:/evil.txt',
    '..\\evil.txt',
    'a\\b.txt',
  ])('refuses the unsafe name %s', async (name) => {
    await expect(checkZip(zipOf([{ name }]))).resolves.toBe('UNSAFE_PATH');
  });

  it('refuses a symbolic link', async () => {
    await expect(
      checkZip(zipOf([{ name: 'link', mode: 0o120777 }])),
    ).resolves.toBe('SYMLINK');
  });

  it('accepts exactly the entry limit and refuses one more', async () => {
    const entries = Array.from(
      { length: AUTOMATION_LIMITS.zipEntries },
      (_, index) => ({ name: `f${index}` }),
    );

    await expect(checkZip(zipOf(entries))).resolves.toBeNull();
    await expect(
      checkZip(zipOf([...entries, { name: 'one-more' }])),
    ).resolves.toBe('TOO_MANY_ENTRIES');
  });

  it('adds up the unpacked size of all entries', async () => {
    const half = AUTOMATION_LIMITS.zipUnpackedBytes / 2;

    await expect(
      checkZip(
        zipOf([
          { name: 'a', unpackedSize: half },
          { name: 'b', unpackedSize: half },
        ]),
      ),
    ).resolves.toBeNull();
    await expect(
      checkZip(
        zipOf([
          { name: 'a', unpackedSize: half },
          { name: 'b', unpackedSize: half + 1 },
        ]),
      ),
    ).resolves.toBe('TOO_LARGE_UNPACKED');
  });
});

interface RealFile {
  name: string;
  data?: Buffer | string;
  mode?: number;
  encrypted?: boolean;
}

/** A zip with real contents, written by hand so it can repeat names or claim to be encrypted. Stored, so sizes stay large. */
function fullZip(files: RealFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const plain = Buffer.from(file.data ?? '');
    const packed = deflateRawSync(plain, { level: 0 });
    const flags = 0x0800 | (file.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(plain.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((file.mode ?? 0) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
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

// archiver is ESM-only and Jest cannot load it, so this stands in.
class MockZipArchive extends EventEmitter {
  static last: MockZipArchive;
  readonly written: RealFile[] = [];

  constructor() {
    super();
    MockZipArchive.last = this;
  }

  append(
    source: Buffer | Readable,
    data: { name: string; mode?: number },
  ): this {
    void this.bytes(source)
      .then((bytes) => {
        // Like archiver: 0644 when no mode is passed.
        this.written.push({
          name: data.name,
          data: bytes,
          mode: 0o100000 | (data.mode ?? 0o644),
        });
        this.emit('entry', data);
      })
      .catch((error: unknown) => this.emit('error', error));

    return this;
  }

  finalize(): Promise<void> {
    this.emit('data', fullZip(this.written));
    this.emit('end');

    return Promise.resolve();
  }

  abort(): this {
    return this;
  }

  private async bytes(source: Buffer | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(source)) return source;

    const chunks: Buffer[] = [];

    for await (const chunk of source) chunks.push(chunk as Buffer);

    return Buffer.concat(chunks);
  }
}

jest.mock('archiver', () => ({ ZipArchive: MockZipArchive }));

describe('files inside a zip', () => {
  const problemOf = (run: Promise<unknown>) =>
    run.then(
      () => null,
      (error: unknown) => (error as ZipFileError).problem,
    );

  describe('listZipFiles', () => {
    it('lists each file once with its size and leaves out folders', async () => {
      const { names, files } = await listZipFiles(
        fullZip([
          { name: 'b/' },
          { name: 'b/two.txt', data: 'twotwo' },
          { name: 'a.txt', data: 'one' },
          { name: 'a.txt', data: 'again' },
        ]),
      );

      expect(names).toEqual(['b/', 'b/two.txt', 'a.txt', 'a.txt']);
      expect(files).toEqual([
        { path: 'a.txt', size: 3 },
        { path: 'b/two.txt', size: 6 },
      ]);
    });

    it('calls a file that is not a zip not editable', async () => {
      await expect(problemOf(listZipFiles(Buffer.from('nope')))).resolves.toBe(
        'NOT_EDITABLE',
      );
    });
  });

  describe('readZipFile', () => {
    it('reads text and matches a name with spaces exactly', async () => {
      await expect(
        readZipFile(
          fullZip([{ name: 'my tests/a b.txt', data: 'hello' }]),
          'my tests/a b.txt',
        ),
      ).resolves.toEqual({ content: 'hello', not_editable: null });
    });

    it('keeps a byte order mark and Windows line ends', async () => {
      await expect(
        readZipFile(fullZip([{ name: 'a', data: '\uFEFFx\r\ny' }]), 'a'),
      ).resolves.toEqual({ content: '\uFEFFx\r\ny', not_editable: null });
    });

    it.each([
      ['a NUL byte', Buffer.from('a\0b')],
      ['invalid UTF-8', Buffer.from([0x41, 0xff, 0xfe])],
    ])('treats %s as binary', async (_, data) => {
      await expect(
        readZipFile(fullZip([{ name: 'a', data }]), 'a'),
      ).resolves.toEqual({ content: null, not_editable: 'binary' });
    });

    it('accepts exactly 1 MB and refuses one byte more', async () => {
      const limit = AUTOMATION_LIMITS.fileTextBytes;

      await expect(
        readZipFile(fullZip([{ name: 'a', data: 'x'.repeat(limit) }]), 'a'),
      ).resolves.toMatchObject({ not_editable: null });

      // This entry has no data behind it, so opening it would fail: it is refused from its stated size.
      await expect(
        readZipFile(zipOf([{ name: 'a', unpackedSize: limit + 1 }]), 'a'),
      ).resolves.toEqual({ content: null, not_editable: 'too_large' });
    });

    it('finds nothing for a missing file or a folder', async () => {
      const zip = fullZip([{ name: 'a/' }, { name: 'a/b', data: 'x' }]);

      await expect(readZipFile(zip, 'nope')).resolves.toBeNull();
      await expect(readZipFile(zip, 'a/')).resolves.toBeNull();
    });

    it('refuses an encrypted file', async () => {
      await expect(
        problemOf(
          readZipFile(
            fullZip([{ name: 'a', data: 'x', encrypted: true }]),
            'a',
          ),
        ),
      ).resolves.toBe('NOT_EDITABLE');
    });
  });

  describe('rebuildZip', () => {
    it('adds the first file when there is no zip yet', async () => {
      const zip = await rebuildZip(null, 'a.txt', Buffer.from('x'));

      await expect(listZipFiles(zip)).resolves.toMatchObject({
        files: [{ path: 'a.txt', size: 1 }],
      });
    });

    it('keeps other files, folders and every stored mode', async () => {
      await rebuildZip(
        fullZip([
          { name: 'dir/', mode: 0o40755 },
          { name: 'mvnw', data: 'old', mode: 0o100755 },
          { name: 'data.bin', data: Buffer.from([0, 1, 2]), mode: 0o100640 },
        ]),
        'new.txt',
        Buffer.from('new'),
      );

      expect(
        MockZipArchive.last.written.map((file) => [file.name, file.mode]),
      ).toEqual([
        ['dir/', 0o100755],
        ['mvnw', 0o100755],
        ['data.bin', 0o100640],
        ['new.txt', 0o100644],
      ]);
      expect(MockZipArchive.last.written[2].data).toEqual(
        Buffer.from([0, 1, 2]),
      );
    });

    it('keeps the execute bit and the place of an edited script', async () => {
      await rebuildZip(
        fullZip([
          { name: 'mvnw', data: 'old', mode: 0o100755 },
          { name: 'z.txt', data: 'z', mode: 0o100644 },
        ]),
        'mvnw',
        Buffer.from('edited'),
      );

      const [script, other] = MockZipArchive.last.written;

      expect(script).toMatchObject({ name: 'mvnw', mode: 0o100755 });
      expect(script.data).toEqual(Buffer.from('edited'));
      expect(other.name).toBe('z.txt');
    });

    it('falls back to the default mode when the zip stored none', async () => {
      await rebuildZip(
        fullZip([{ name: 'a', data: 'x', mode: 0 }]),
        'b',
        Buffer.from('y'),
      );

      expect(MockZipArchive.last.written[0].mode).toBe(0o100644);
    });

    it('leaves one file behind when a name was repeated', async () => {
      const zip = fullZip([
        { name: 'a', data: '1' },
        { name: 'a', data: '2' },
        { name: 'b', data: '3' },
      ]);

      await rebuildZip(zip, 'a', Buffer.from('new'));
      expect(MockZipArchive.last.written.map((file) => file.name)).toEqual([
        'a',
        'b',
      ]);
      expect(MockZipArchive.last.written[0].data).toEqual(Buffer.from('new'));

      await rebuildZip(zip, 'a', null);
      expect(MockZipArchive.last.written.map((file) => file.name)).toEqual([
        'b',
      ]);
    });

    it('removes further files in the same pass, keeping the rest', async () => {
      await rebuildZip(
        fullZip([
          { name: 'dir/', mode: 0o40755 },
          { name: 'a', data: '1' },
          { name: 'b', data: '2' },
          { name: 'c', data: '3' },
        ]),
        'a',
        null,
        ['c'],
      );

      expect(MockZipArchive.last.written.map((file) => file.name)).toEqual([
        'dir/',
        'b',
      ]);
    });

    it('refuses to rebuild around an encrypted file, but can delete it', async () => {
      const zip = fullZip([
        { name: 'locked', data: 'x', encrypted: true },
        { name: 'open', data: 'y' },
      ]);

      await expect(
        problemOf(rebuildZip(zip, 'open', Buffer.from('z'))),
      ).resolves.toBe('NOT_EDITABLE');

      await rebuildZip(zip, 'locked', null);
      expect(MockZipArchive.last.written.map((file) => file.name)).toEqual([
        'open',
      ]);
    });

    it('stops when the new zip goes over 50 MB', async () => {
      await expect(
        problemOf(
          rebuildZip(
            null,
            'big.bin',
            Buffer.alloc(AUTOMATION_LIMITS.zipBytes + 1),
          ),
        ),
      ).resolves.toBe('TOO_LARGE');
    });

    it('checks the unpacked size from the table of contents before opening anything', async () => {
      const half = AUTOMATION_LIMITS.zipUnpackedBytes / 2;

      await expect(
        problemOf(
          rebuildZip(
            zipOf([
              { name: 'a', unpackedSize: half },
              { name: 'b', unpackedSize: half },
            ]),
            'c',
            Buffer.from('x'),
          ),
        ),
      ).resolves.toBe('TOO_LARGE_UNPACKED');
    });
  });

  describe('collidesWith', () => {
    it.each([
      ['a/b', ['a'], 'a file where a folder is needed'],
      ['a', ['a/b'], 'a folder where a file is needed'],
      ['a', ['a/'], 'a folder entry of the same name'],
      ['a', ['./a'], 'the same file written with ./'],
      ['x/a', ['x/./a'], 'the same file written with /./'],
      ['README.md', ['readme.md'], 'names differing only by case'],
      ['A/b', ['a'], 'a file and a folder differing by case'],
    ])('refuses %s beside %j: %s', (path, names) => {
      expect(collidesWith(path, names)).toBe(true);
    });

    it.each([
      ['a/b', ['a/']],
      ['a/c', ['a/b']],
      ['ab', ['a']],
      ['a', []],
    ])('allows %s beside %j', (path, names) => {
      expect(collidesWith(path, names)).toBe(false);
    });
  });
});
