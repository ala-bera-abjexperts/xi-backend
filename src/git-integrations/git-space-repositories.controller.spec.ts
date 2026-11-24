/**
 * @fileoverview The list names every repository of the tenant, private ones included, so reading it needs the
 * same grant as saving it. Pinned here because a guard's metadata fails silently: nothing breaks when it is wrong.
 * @module src/git-integrations/git-space-repositories.controller.spec
 */

import {
  SPACE_PERMISSION_KEY,
  SPACE_PERMISSION_ORG_ANY_KEY,
} from '../auth/decorators/require-space-permission.decorator';
import { GitSpaceRepositoriesController } from './git-space-repositories.controller';

describe('GitSpaceRepositoriesController permissions', () => {
  it.each(['get', 'put'])(
    '%s needs the space module grant, not just viewing the space',
    (method) => {
      const handler = Object.getOwnPropertyDescriptor(
        GitSpaceRepositoriesController.prototype,
        method,
      )!.value as object;

      expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
        'edit_space_modules',
      );
      expect(
        Reflect.getMetadata(SPACE_PERMISSION_ORG_ANY_KEY, handler),
      ).toEqual(['can_edit_space_modules']);
    },
  );
});
