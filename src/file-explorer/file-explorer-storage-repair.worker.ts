/**
 * @fileoverview Headless File Explorer orphaned-storage repair command.
 * @module src/file-explorer/file-explorer-storage-repair.worker
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FileExplorerStorageRepairService } from './file-explorer-storage-repair.service';
import { FileExplorerStorageRepairWorkerModule } from './file-explorer-storage-repair.worker.module';

export type FileExplorerStorageRepairOptions = { apply: boolean };

export function parseFileExplorerStorageRepairArgs(
  args: readonly string[],
): FileExplorerStorageRepairOptions {
  const accepted = new Set(['--apply', '--confirm']);
  const unknown = args.filter((arg) => !accepted.has(arg));
  if (unknown.length) {
    throw new Error(`Unknown option(s): ${unknown.join(', ')}`);
  }

  const apply = args.includes('--apply');
  if (apply !== args.includes('--confirm')) {
    throw new Error(
      'Destructive execution requires both --apply and --confirm',
    );
  }

  return { apply };
}

async function bootstrap(): Promise<void> {
  const options = parseFileExplorerStorageRepairArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(
    FileExplorerStorageRepairWorkerModule,
    { logger: false },
  );

  try {
    const repair = app.get(FileExplorerStorageRepairService);
    const result = await repair.repair(options.apply);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`File Explorer storage repair failed: ${message}\n`);
    process.exitCode = 1;
  });
}
