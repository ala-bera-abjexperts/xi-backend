/**
 * @fileoverview Fixed-space narrowing for the multi-space Resource Planning views (report,
 * schedule). A requested `space_id` must be one the caller's SpaceScope allows; rows then match
 * that space exactly, so null-space (tenant-level) rows drop out of a single-space view.
 * @module src/resource-planning/space-scope.util
 */

import { ForbiddenException } from '@nestjs/common';
import { inSpaceScope, type SpaceScope } from './resource-planning.service';

/** 403 unless `spaceId` is in the caller's scope -- run before loading any data. */
export function assertSpaceInScope(scope: SpaceScope, spaceId: string): void {
  if (!scope.allowedSpaceIds.has(spaceId)) {
    throw new ForbiddenException(
      'Resource Planning is not available in this space',
    );
  }
}

/**
 * Row predicate on a row's space id: an exact match when `onlySpaceId` is set (null/undefined
 * rows fail), otherwise the multi-space inSpaceScope rule (null passes, undefined fails closed).
 */
export function rowSpaceFilter(
  scope: SpaceScope,
  onlySpaceId?: string,
): (rowSpaceId: string | null | undefined) => boolean {
  if (onlySpaceId) return (rowSpaceId) => rowSpaceId === onlySpaceId;
  return (rowSpaceId) => inSpaceScope(scope, rowSpaceId);
}
