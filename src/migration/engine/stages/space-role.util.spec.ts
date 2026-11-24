/**
 * Unit tests for the Jira role name → space role mapping (pure — no DI, no DB).
 *
 * The regression this file exists for: German Jira ships the project administrator role as
 * `Administratoren`, the previous `/^administrators?$/i` missed it, and every project administrator
 * on that instance was silently migrated as an ordinary `member` with nothing logged.
 */

import { mapSpaceRole } from './space-role.util';

describe('mapSpaceRole', () => {
  describe('administrator roles become space admins', () => {
    it.each([
      [
        'Administratoren',
        'the German default — the regression this exists for',
      ],
      ['Administrators', 'the English default'],
      ['Administrator', 'the singular English form'],
      ['  administratoren  ', 'surrounding whitespace'],
      ['ADMINISTRATORS', 'shouted'],
    ])('%s → admin (%s)', (name) => {
      expect(mapSpaceRole(name)).toEqual({ role: 'admin', matched: true });
    });
  });

  describe('everything else becomes a member, and says so', () => {
    it.each([
      'Entwickler',
      'Developers',
      'Benutzer',
      'Users',
      'atlassian-addons-project-access',
    ])('%s → member, matched:false', (name) => {
      expect(mapSpaceRole(name)).toEqual({ role: 'member', matched: false });
    });

    it('never throws on an empty or whitespace-only name', () => {
      expect(mapSpaceRole('')).toEqual({ role: 'member', matched: false });
      expect(mapSpaceRole('   ')).toEqual({ role: 'member', matched: false });
    });
  });

  it('does not match on a substring — "Nicht-Administratoren" is not an admin role', () => {
    expect(mapSpaceRole('Nicht-Administratoren').role).toBe('member');
    expect(mapSpaceRole('Administrators (read only)').role).toBe('member');
  });
});
