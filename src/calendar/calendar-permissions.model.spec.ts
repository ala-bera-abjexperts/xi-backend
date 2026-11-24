/**
 * @fileoverview The permission matrix a calendar share carries.
 *
 * These are the rules every calendar endpoint is decided by, so they are checked on their own, away
 * from any database: what the old `view`/`edit`/`manage` levels mean now, how two rules combine, and
 * what a space is allowed to cap them to.
 */
import {
  allPermissions,
  capPermissions,
  ceilingFromSpace,
  fromLegacyLevel,
  grantsAnyWrite,
  grantsNothing,
  mergePermissions,
  noPermissions,
  permissionsFromShare,
  readOnlyPermissions,
} from './calendar-permissions.model';

describe('calendar permissions', () => {
  describe('a rule written the old way', () => {
    it('reads `view` as seeing every kind of content and changing none', () => {
      const permissions = fromLegacyLevel('view');

      expect(permissions.events.own_read).toBe(true);
      expect(permissions.events.others_read).toBe(true);
      expect(permissions.task_events.read).toBe(true);
      expect(permissions.sync.read).toBe(true);
      expect(grantsAnyWrite(permissions)).toBe(false);
    });

    it('reads `edit` as entry work, still without managing the calendar', () => {
      const permissions = fromLegacyLevel('edit');

      expect(permissions.events.create).toBe(true);
      expect(permissions.events.own_update).toBe(true);
      expect(permissions.events.others_delete).toBe(true);
      expect(permissions.manage).toBe(false);
      expect(permissions.sync.manage).toBe(false);
    });

    it('reads `manage` as everything', () => {
      expect(fromLegacyLevel('manage')).toEqual(allPermissions());
    });

    it('treats an unknown level as the weakest one rather than refusing outright', () => {
      // Storage is jsonb, so a level nobody recognises must not become an accidental grant.
      expect(fromLegacyLevel('something-else')).toEqual(
        fromLegacyLevel('view'),
      );
    });

    it('is what a stored row without a permissions object still means', () => {
      expect(permissionsFromShare({ level: 'edit' })).toEqual(
        fromLegacyLevel('edit'),
      );
    });

    it('falls back to view when a row carries no level at all', () => {
      expect(permissionsFromShare({})).toEqual(fromLegacyLevel('view'));
    });
  });

  describe('a rule written the new way', () => {
    it('grants exactly the flags it names and nothing beside them', () => {
      const permissions = permissionsFromShare({
        permissions: {
          events: { own: { read: true, update: true } },
          task_events: { read: true },
        },
      });

      expect(permissions.events.own_read).toBe(true);
      expect(permissions.events.own_update).toBe(true);
      expect(permissions.events.own_delete).toBe(false);
      expect(permissions.events.others_read).toBe(false);
      expect(permissions.task_events.read).toBe(true);
      expect(permissions.sync.read).toBe(false);
    });

    it('wins over a level left beside it, so the explicit rule is the one that counts', () => {
      const permissions = permissionsFromShare({
        level: 'manage',
        permissions: { events: { own: { read: true } } },
      });

      expect(permissions.manage).toBe(false);
      expect(permissions.events.others_read).toBe(false);
    });

    it('grants managing the calendar without granting anything below it', () => {
      const permissions = permissionsFromShare({
        permissions: { manage: true },
      });

      expect(permissions.manage).toBe(true);
      expect(permissions.events.own_read).toBe(false);
      expect(permissions.integrations.delete).toBe(false);
      expect(permissions.sync.manage).toBe(false);
    });

    it('honours a box unticked beside manage, instead of overruling it', () => {
      // The reported case: administering the calendar must not hand back a power taken away by hand.
      const permissions = permissionsFromShare({
        permissions: {
          manage: true,
          integrations: { create: true, delete: false },
        },
      });

      expect(permissions.manage).toBe(true);
      expect(permissions.integrations.create).toBe(true);
      expect(permissions.integrations.delete).toBe(false);
    });

    it('ignores a value that is not exactly true', () => {
      const permissions = permissionsFromShare({
        permissions: {
          events: { create: 'yes' as unknown as boolean },
        },
      });

      expect(permissions.events.create).toBe(false);
    });
  });

  describe('combining rules', () => {
    it('adds up, because a person can be named by several rules at once', () => {
      const merged = mergePermissions(
        permissionsFromShare({
          permissions: { events: { own: { read: true } } },
        }),
        permissionsFromShare({ permissions: { task_events: { read: true } } }),
      );

      expect(merged.events.own_read).toBe(true);
      expect(merged.task_events.read).toBe(true);
    });

    it('never takes away: a weaker rule cannot cancel a stronger one', () => {
      const merged = mergePermissions(
        fromLegacyLevel('edit'),
        fromLegacyLevel('view'),
      );

      expect(merged.events.create).toBe(true);
    });

    it('leaves both sides untouched', () => {
      const first = fromLegacyLevel('view');
      const second = fromLegacyLevel('edit');

      mergePermissions(first, second);

      expect(first.events.create).toBe(false);
      expect(second.manage).toBe(false);
    });
  });

  describe('capping by the space', () => {
    it('keeps only what the ceiling also allows', () => {
      const capped = capPermissions(allPermissions(), readOnlyPermissions());

      expect(capped.events.others_read).toBe(true);
      expect(capped.events.others_update).toBe(false);
      expect(capped.manage).toBe(false);
    });

    it('cannot widen: a ceiling never turns a missing flag on', () => {
      const capped = capPermissions(noPermissions(), allPermissions());

      expect(grantsNothing(capped)).toBe(true);
    });
  });

  describe('the ceiling a space sets', () => {
    const allowing =
      (...keys: string[]) =>
      (key: string) =>
        keys.includes(key);

    it('shuts everything when the space does not allow the calendar at all', () => {
      expect(ceilingFromSpace(allowing())).toEqual(noPermissions());
    });

    it('opens everything when the space allows managing calendars', () => {
      expect(
        ceilingFromSpace(allowing('view_calendar', 'manage_calendars')),
      ).toEqual(allPermissions());
    });

    it('allows reading every kind of content off the view permission alone', () => {
      const ceiling = ceilingFromSpace(allowing('view_calendar'));

      expect(ceiling.events.own_read).toBe(true);
      expect(ceiling.events.others_read).toBe(true);
      expect(ceiling.task_events.read).toBe(true);
      expect(ceiling.sync.read).toBe(true);

      // Every write this ceiling governs stays shut. The connection is not one of them — no key here
      // speaks for it, so the share alone decides.
      expect(ceiling.events.create).toBe(false);
      expect(ceiling.events.own_update).toBe(false);
      expect(ceiling.events.own_delete).toBe(false);
      expect(ceiling.task_events.update).toBe(false);
      expect(ceiling.task_events.delete).toBe(false);
      expect(ceiling.sync.create).toBe(false);
      expect(ceiling.sync.update).toBe(false);
      expect(ceiling.sync.delete).toBe(false);
      expect(ceiling.manage).toBe(false);
    });

    it('opens each write on its own key, so create never implies delete', () => {
      const ceiling = ceilingFromSpace(
        allowing('view_calendar', 'create_calendar_entries'),
      );

      expect(ceiling.events.create).toBe(true);
      expect(ceiling.sync.create).toBe(true);
      expect(ceiling.events.own_update).toBe(false);
      expect(ceiling.events.own_delete).toBe(false);
    });

    it('lets the delete key reach ticket dates and synced copies too', () => {
      const ceiling = ceilingFromSpace(
        allowing('view_calendar', 'delete_calendar_entries'),
      );

      expect(ceiling.events.others_delete).toBe(true);
      expect(ceiling.task_events.delete).toBe(true);
      expect(ceiling.sync.delete).toBe(true);
    });

    it('never hands out managing the calendar without the manage key', () => {
      const ceiling = ceilingFromSpace(
        allowing(
          'view_calendar',
          'create_calendar_entries',
          'edit_calendar_entries',
          'delete_calendar_entries',
        ),
      );

      expect(ceiling.manage).toBe(false);
      expect(ceiling.sync.manage).toBe(false);
    });
  });

  describe('the two questions the endpoints ask', () => {
    it('counts a rule with no read at all as showing nothing', () => {
      expect(grantsNothing(noPermissions())).toBe(true);
      expect(grantsNothing(readOnlyPermissions())).toBe(false);
    });

    it('counts reading alone as no write', () => {
      expect(grantsAnyWrite(readOnlyPermissions())).toBe(false);
      expect(grantsAnyWrite(allPermissions())).toBe(true);
    });

    it('counts managing the connection as a write, since it changes what appears', () => {
      const permissions = noPermissions();

      permissions.sync.manage = true;

      expect(grantsAnyWrite(permissions)).toBe(true);
    });
  });
});
