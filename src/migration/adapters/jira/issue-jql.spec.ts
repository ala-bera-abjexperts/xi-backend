/**
 * Issue-JQL composition tests (pure).
 *
 * Both guarantees under test are silent-corruption guards, not cosmetics:
 *  - no ORDER BY → unstable offset paging → issues silently duplicated across pages and others
 *    skipped, while the run still reports success;
 *  - no forced project predicate → a user filter could pull ANOTHER project's issues into this job's
 *    space and crosswalk.
 */

import { buildIssueJql, stripOrderBy } from './issue-jql';

describe('buildIssueJql', () => {
  describe('always stable-ordered (offset paging correctness)', () => {
    it('orders by key for the unfiltered project', () => {
      expect(buildIssueJql('SDP')).toBe('project = "SDP" ORDER BY key ASC');
    });

    it('orders by key when a filter is supplied', () => {
      expect(buildIssueJql('SDP', 'status = "To Do"')).toBe(
        'project = "SDP" AND (status = "To Do") ORDER BY key ASC',
      );
    });

    it("replaces the user's own ORDER BY rather than emitting two", () => {
      expect(buildIssueJql('SDP', 'status = Done ORDER BY created DESC')).toBe(
        'project = "SDP" AND (status = Done) ORDER BY key ASC',
      );
    });

    it('every composition ends in ORDER BY key ASC', () => {
      for (const f of [
        undefined,
        '',
        '   ',
        'x = 1',
        'x = 1 ORDER BY y',
        'ORDER BY z DESC',
      ]) {
        expect(buildIssueJql('SDP', f)).toMatch(/ORDER BY key ASC$/);
      }
    });
  });

  describe('the project predicate cannot be escaped or redirected', () => {
    it('AND-s the project in, so a filter can only narrow this job', () => {
      expect(buildIssueJql('SDP', 'project = OTHER')).toBe(
        'project = "SDP" AND (project = OTHER) ORDER BY key ASC',
      );
      // Contradictory, so it returns nothing — which is correct. It must never return OTHER's issues.
    });

    it("parenthesises the filter so a top-level OR can't widen the scope", () => {
      // Unparenthesised this parses as `(project="SDP" AND a) OR b` — b would match ANY project.
      expect(buildIssueJql('SDP', 'a = 1 OR b = 2')).toBe(
        'project = "SDP" AND (a = 1 OR b = 2) ORDER BY key ASC',
      );
    });

    it("always starts with the job's own project", () => {
      for (const f of [undefined, 'x = 1', 'project = OTHER', 'a OR b']) {
        expect(buildIssueJql('SDP', f)).toMatch(/^project = "SDP"/);
      }
    });

    it('strips quotes from the project key so the clause cannot be broken out of', () => {
      expect(buildIssueJql('S"DP')).toBe('project = "SDP" ORDER BY key ASC');
    });
  });

  describe('blank filters mean "the whole project", not an empty AND ()', () => {
    it.each([undefined, null, '', '   ', 'ORDER BY created DESC'])(
      'treats %p as no filter',
      (f) => {
        expect(buildIssueJql('SDP', f as string | undefined)).toBe(
          'project = "SDP" ORDER BY key ASC',
        );
      },
    );
  });

  it('composes the real E2E slice', () => {
    expect(buildIssueJql('SDP', 'key <= SDP-25')).toBe(
      'project = "SDP" AND (key <= SDP-25) ORDER BY key ASC',
    );
  });
});

describe('stripOrderBy', () => {
  it('removes a trailing ORDER BY, case-insensitively, and trims', () => {
    expect(stripOrderBy('a = 1 ORDER BY key ASC')).toBe('a = 1');
    expect(stripOrderBy('a = 1 order by key desc')).toBe('a = 1');
    expect(stripOrderBy('a = 1   ORDER   BY   key')).toBe('a = 1');
  });

  it('leaves a filter without ORDER BY untouched', () => {
    expect(stripOrderBy('a = 1 AND b = 2')).toBe('a = 1 AND b = 2');
  });

  it('does not maul a field that merely contains the word "order"', () => {
    expect(stripOrderBy('sort_order = 3')).toBe('sort_order = 3');
    expect(stripOrderBy('summary ~ "reorder"')).toBe('summary ~ "reorder"');
  });
});
