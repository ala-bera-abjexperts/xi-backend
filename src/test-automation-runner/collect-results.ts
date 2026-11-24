import { constants } from 'fs';
import { lstat, open, readdir } from 'fs/promises';
import { basename, join, relative } from 'path';

import { TEST_TRANSFER_LIMITS } from '../test-management/dto/test-transfer.dto';

export const MAX_RESULT_FILES = 20;

export type ResultProblemCode =
  | 'OUTSIDE_RUN_FOLDER'
  | 'NOT_XML'
  | 'NOT_A_FILE'
  | 'TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'NOT_FROM_THIS_RUN';

export interface ResultProblem {
  path: string;
  code: ResultProblemCode;
}

export interface CollectedResult {
  // Inside the run folder, for logs and messages.
  path: string;
  name: string;
  buffer: Buffer;
}

export interface CollectedResults {
  files: CollectedResult[];
  problems: ResultProblem[];
}

function segmentPattern(segment: string): RegExp | null {
  if (!/[*?]/.test(segment)) return null;

  const body = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${body}$`);
}

/** Paths matching a pattern. A wildcard stays in one folder, so "**" works like "*"; links are never followed. */
export async function matches(
  folder: string,
  segments: string[],
): Promise<string[]> {
  const [segment, ...rest] = segments;
  const pattern = segmentPattern(segment);
  const names = pattern
    ? (await readdir(folder).catch(() => [] as string[]))
        .filter((name) => pattern.test(name))
        .sort()
    : [segment];
  const found: string[] = [];

  for (const name of names) {
    const path = join(folder, name);

    if (rest.length === 0) {
      found.push(path);
      continue;
    }

    const info = await lstat(path).catch(() => null);

    if (info?.isDirectory()) found.push(...(await matches(path, rest)));
  }

  return found;
}

/** Reads a regular file; opening refuses a link, and does not hang on a named pipe the tests left behind. */
export async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer | 'NOT_A_FILE' | 'TOO_LARGE'> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);

  if (!handle) return 'NOT_A_FILE';

  try {
    const info = await handle.stat();

    if (!info.isFile()) return 'NOT_A_FILE';
    if (info.size > maxBytes) return 'TOO_LARGE';

    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function resultCandidates(
  runFolder: string,
  workDir: string | null,
  resultPaths: string[],
  problems: ResultProblem[],
): Promise<Set<string>> {
  const candidates = new Set<string>();

  for (const resultPath of resultPaths) {
    const segments = [workDir ?? '', resultPath]
      .join('/')
      .split('/')
      .filter((segment) => segment && segment !== '.');

    // Settings are checked when saved; this keeps an old or edited snapshot inside the folder too.
    if (segments.length === 0 || segments.includes('..')) {
      problems.push({ path: resultPath, code: 'OUTSIDE_RUN_FOLDER' });
      continue;
    }

    for (const path of await matches(runFolder, segments)) {
      candidates.add(path);
    }
  }

  return candidates;
}

/** What the project already holds before the tests, so an old file can't pass as this run's. */
export async function snapshotResults(
  runFolder: string,
  workDir: string | null,
  resultPaths: string[],
): Promise<Map<string, number>> {
  const before = new Map<string, number>();
  const candidates = await resultCandidates(
    runFolder,
    workDir,
    resultPaths,
    [],
  );

  for (const path of candidates) {
    const info = await lstat(path).catch(() => null);

    if (info) before.set(path, info.mtimeMs);
  }

  return before;
}

/**
 * Picks up the result files a run wrote. Only regular XML files inside the run folder count, and each file gets a
 * comment naming the run: the duplicate check would otherwise refuse a second run whose output is identical.
 */
export async function collectResults(
  runFolder: string,
  workDir: string | null,
  resultPaths: string[],
  runId: string,
  before = new Map<string, number>(),
): Promise<CollectedResults> {
  const problems: ResultProblem[] = [];
  const candidates = await resultCandidates(
    runFolder,
    workDir,
    resultPaths,
    problems,
  );
  const files: CollectedResult[] = [];

  for (const candidate of [...candidates].sort()) {
    const path = relative(runFolder, candidate);

    if (!candidate.toLowerCase().endsWith('.xml')) {
      // A literal path that was never written is simply missing.
      if (await lstat(candidate).catch(() => null)) {
        problems.push({ path, code: 'NOT_XML' });
      }

      continue;
    }

    const info = await lstat(candidate).catch(() => null);

    if (!info) continue;

    if (before.get(candidate) === info.mtimeMs) {
      problems.push({ path, code: 'NOT_FROM_THIS_RUN' });
      continue;
    }

    if (files.length === MAX_RESULT_FILES) {
      problems.push({ path, code: 'TOO_MANY_FILES' });
      break;
    }

    const content = await readRegularFile(
      candidate,
      TEST_TRANSFER_LIMITS.junitBytes,
    );

    if (!Buffer.isBuffer(content)) {
      problems.push({ path, code: content });
      continue;
    }

    files.push({
      path,
      name: basename(candidate),
      buffer: Buffer.concat([
        content,
        Buffer.from(
          `\n<!-- xisuite-automation-run ${runId}/${files.length + 1} -->\n`,
        ),
      ]),
    });
  }

  return { files, problems };
}
