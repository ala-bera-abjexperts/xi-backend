import { mkdir, mkdtemp, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';

import { findingDetail } from '../../../../test-management/automation/custom-images/registry/custom-image-review';
import { runDocker, type DockerExec } from '../../../docker-driver';
import { runnerWorkDir } from '../../../runner.sweep';
import { SCANNER_LABEL } from '../../docker/custom-image-docker';

const SCAN_MAX_BYTES = 64 * 1024 * 1024;

export interface ScanResult {
  scanner: string;
  packages: Set<string>;
  systemPackages: Set<string>;
  critical: number;
  high: number;
  secrets: { rule: string; severity: string; path: string }[];
}

export type ScanImage = (
  image: string,
  signal: AbortSignal,
  onOutput?: (chunk: Buffer) => void,
  // A folder that already holds the image as image.tar, such as an uploaded file; the caller removes it.
  savedIn?: string,
) => Promise<ScanResult>;

/** A problem that may pass, such as a rate limit; the check is tried again later. */
export class TryLater extends Error {}

/** The Trivy image to scan with, from TM_RUNNER_SCANNER=docker:<image>@sha256:…; null when it names none. */
export function scannerImage(
  raw = process.env.TM_RUNNER_SCANNER,
): string | null {
  const value = raw?.trim() ?? '';

  return value.startsWith('docker:') ? value.slice('docker:'.length) : null;
}

// Under the work folder, because a worker in a container shares only that path with the host's Docker.
function scanFolders(): { scans: string; cache: string } {
  return {
    scans: join(runnerWorkDir(), 'scans'),
    // Trivy's vulnerability database, kept between scans so it isn't downloaded every time.
    cache: join(runnerWorkDir(), 'trivy-cache'),
  };
}

/** Runs Trivy from its image against a saved copy of the image; it gets no access to Docker or other containers. */
export function dockerTrivyScanner(
  scannerImageRef: string,
  exec: DockerExec = runDocker,
): ScanImage {
  return async (image, signal, onOutput, savedIn) => {
    const { scans, cache } = scanFolders();

    await mkdir(scans, { recursive: true, mode: 0o700 });

    const folder = savedIn ?? (await mkdtemp(join(scans, 'scan-')));
    const owner =
      typeof process.getuid === 'function' &&
      typeof process.getgid === 'function'
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : [];

    try {
      await mkdir(cache, { recursive: true, mode: 0o700 });

      if (!savedIn) {
        onOutput?.(Buffer.from('Copying the image for the scanner\n'));

        const saved = await exec(
          ['save', '--output', join(folder, 'image.tar'), image],
          signal,
        );

        if (saved.code !== 0) {
          throw new TryLater('The image could not be handed to the scanner');
        }
      }

      const args = [
        'run',
        '--rm',
        '--pull',
        'never',
        '--label',
        SCANNER_LABEL,
        ...owner,
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp',
        '--env',
        'HOME=/tmp',
        '--mount',
        `type=bind,src=${folder},dst=/scan`,
        '--mount',
        `type=bind,src=${cache},dst=/cache`,
        scannerImageRef,
        'image',
        '--cache-dir',
        '/cache',
        '--no-progress',
        '--format',
        'json',
        '--output',
        '/scan/scan.json',
        '--list-all-pkgs',
        '--scanners',
        'vuln,secret',
        '--timeout',
        '10m',
        '--input',
        '/scan/image.tar',
      ];
      const result = onOutput
        ? await exec(args, signal, onOutput)
        : await exec(args, signal);
      const output = join(folder, 'scan.json');

      if (result.code !== 0) {
        throw new TryLater('The scanner stopped with an error');
      }

      if ((await stat(output)).size > SCAN_MAX_BYTES) {
        throw new TryLater('The scan result is too large');
      }

      return readScan(await readFile(output, 'utf8'), scannerImageRef);
    } finally {
      await rm(savedIn ? join(folder, 'scan.json') : folder, {
        recursive: true,
        force: true,
      });
    }
  };
}

/** Keeps only what the check needs from Trivy's report; secret values are dropped. */
export function readScan(text: string, scanner: string): ScanResult {
  const report = JSON.parse(text) as {
    Results?: {
      Class?: string;
      Target?: string;
      Packages?: { Name?: unknown }[];
      Vulnerabilities?: { Severity?: unknown }[];
      Secrets?: { RuleID?: unknown; Severity?: unknown }[];
    }[];
  };
  const result: ScanResult = {
    scanner,
    packages: new Set(),
    systemPackages: new Set(),
    critical: 0,
    high: 0,
    secrets: [],
  };

  for (const part of report.Results ?? []) {
    for (const item of part.Packages ?? []) {
      if (typeof item.Name !== 'string') continue;

      const name = item.Name.toLowerCase();

      result.packages.add(name);
      if (part.Class === 'os-pkgs') result.systemPackages.add(name);
    }

    for (const item of part.Vulnerabilities ?? []) {
      if (item.Severity === 'CRITICAL') result.critical += 1;
      if (item.Severity === 'HIGH') result.high += 1;
    }

    for (const item of part.Secrets ?? []) {
      result.secrets.push({
        rule: findingDetail(typeof item.RuleID === 'string' ? item.RuleID : ''),
        severity: findingDetail(
          typeof item.Severity === 'string' ? item.Severity : '',
        ),
        path: findingDetail(String(part.Target ?? '')),
      });
    }
  }

  return result;
}
