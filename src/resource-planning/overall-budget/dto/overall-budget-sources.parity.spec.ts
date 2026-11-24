/**
 * @fileoverview Keeps the Overall Budget source codes identical in the backend
 * DTO and the frontend dropdown. The backend rejects any other code, so a
 * frontend option missing here would fail on save. Skipped when the frontend
 * repo is not checked out next to this one.
 * @module src/resource-planning/overall-budget/dto/overall-budget-sources.parity.spec
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OVERALL_BUDGET_SOURCES } from './overall-budget.dto';

const FRONTEND_MODEL = resolve(
  process.cwd(),
  '..',
  'risk-management-app',
  'src',
  'models',
  'resource-planning.model.ts',
);

const describeWithFrontend = existsSync(FRONTEND_MODEL)
  ? describe
  : describe.skip;

describeWithFrontend('Overall Budget source codes parity', () => {
  it('matches the frontend OVERALL_BUDGET_SOURCES in order', () => {
    const body =
      /export const OVERALL_BUDGET_SOURCES\b[^=]*=\s*\[(.*?)\]\s*as const/s.exec(
        readFileSync(FRONTEND_MODEL, 'utf8'),
      )?.[1] ?? '';

    expect([...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual(
      [...OVERALL_BUDGET_SOURCES],
    );
  });
});
