import { ForbiddenException } from '@nestjs/common';
import type { SpaceScope } from './resource-planning.service';
import { assertSpaceInScope, rowSpaceFilter } from './space-scope.util';

const scope: SpaceScope = {
  allowedSpaceIds: new Set(['s1', 's2']),
  allowsNullSpace: true,
};

describe('space-scope util', () => {
  it('matches exactly the requested space and excludes null/undefined rows', () => {
    const inSpace = rowSpaceFilter(scope, 's1');

    expect(inSpace('s1')).toBe(true);
    expect(inSpace('s2')).toBe(false);
    expect(inSpace(null)).toBe(false);
    expect(inSpace(undefined)).toBe(false);
  });

  it('falls back to inSpaceScope when no space is requested', () => {
    const inScope = rowSpaceFilter(scope);

    expect(inScope('s2')).toBe(true);
    expect(inScope('s3')).toBe(false);
    expect(inScope(null)).toBe(true);
    expect(inScope(undefined)).toBe(false);
  });

  it('403s a space outside the scope and passes an allowed one', () => {
    expect(() => assertSpaceInScope(scope, 's3')).toThrow(ForbiddenException);
    expect(() => assertSpaceInScope(scope, 's3')).toThrow(
      'Resource Planning is not available in this space',
    );
    expect(() => assertSpaceInScope(scope, 's1')).not.toThrow();
  });
});
