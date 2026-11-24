import { parseFileExplorerStorageRepairArgs } from './file-explorer-storage-repair.worker';

describe('parseFileExplorerStorageRepairArgs', () => {
  it('defaults to a non-mutating inventory', () => {
    expect(parseFileExplorerStorageRepairArgs([])).toEqual({ apply: false });
  });

  it('requires both destructive flags', () => {
    expect(() => parseFileExplorerStorageRepairArgs(['--apply'])).toThrow(
      'requires both --apply and --confirm',
    );
    expect(() => parseFileExplorerStorageRepairArgs(['--confirm'])).toThrow(
      'requires both --apply and --confirm',
    );
  });

  it('accepts explicitly confirmed execution', () => {
    expect(
      parseFileExplorerStorageRepairArgs(['--apply', '--confirm']),
    ).toEqual({
      apply: true,
    });
  });
});
