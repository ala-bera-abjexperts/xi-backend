/**
 * @fileoverview Keeps the Resource Planning currency list identical in the
 * backend allow-list and the frontend picker.
 * @module src/resource-planning/dto/capacity-currencies.parity.spec
 * @author Prince Jadiya
 *
 * The backend rejects any currency outside SUPPORTED_CAPACITY_CURRENCIES, so a
 * frontend option missing here would fail on save, and a backend code missing
 * in the frontend could never be picked. Skipped when the frontend repo is not
 * checked out next to this one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SUPPORTED_CAPACITY_CURRENCIES } from './capacity-period.dto';

const FRONTEND_MODEL = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'models',
  'resource-planning.model.ts',
);

/** Codes of the frontend `RESOURCE_PLANNING_CURRENCIES` tuple, in order. */
function parseCurrencies(source: string): string[] {
  const body =
    /export const RESOURCE_PLANNING_CURRENCIES\b[^=]*=\s*\[(.*?)\]\s*as const/s.exec(
      source,
    )?.[1];

  return body ? [...body.matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]) : [];
}

/** Value of the frontend `DEFAULT_RESOURCE_PLANNING_CURRENCY`. */
function parseDefault(source: string): string | undefined {
  return /DEFAULT_RESOURCE_PLANNING_CURRENCY\b[^=]*=\s*'([A-Z]{3})'/.exec(
    source,
  )?.[1];
}

const describeIfSibling = existsSync(FRONTEND_MODEL) ? describe : describe.skip;

describeIfSibling('resource planning currency parity', () => {
  const source = readFileSync(FRONTEND_MODEL, 'utf-8');
  const frontend = parseCurrencies(source);

  it('parses a non-trivial list from the frontend model', () => {
    // Guards against the parser returning [] and the checks below passing vacuously.
    expect(frontend.length).toBeGreaterThan(10);
  });

  it('matches SUPPORTED_CAPACITY_CURRENCIES in the same order', () => {
    expect(frontend).toEqual([...SUPPORTED_CAPACITY_CURRENCIES]);
  });

  it('defaults to EUR, which is in the list', () => {
    const fallback = parseDefault(source);
    expect(fallback).toBe('EUR');
    expect(SUPPORTED_CAPACITY_CURRENCIES).toContain(fallback);
  });

  it('has no duplicate entries', () => {
    expect(new Set(SUPPORTED_CAPACITY_CURRENCIES).size).toBe(
      SUPPORTED_CAPACITY_CURRENCIES.length,
    );
    expect(new Set(frontend).size).toBe(frontend.length);
  });
});
