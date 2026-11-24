/**
 * Unit tests for the account-provisioning gate (pure — no DI, no DB).
 *
 * This gate is the only thing standing between a migration roster and real logins plus real mail.
 * Every case below is drawn from an actual customer's source user list.
 */

import { isProvisionableEmail } from './provisionable-email.util';

describe('isProvisionableEmail', () => {
  it('accepts an ordinary personal address', () => {
    for (const email of [
      'michael.zwach@muenzeoesterreich.at',
      'thomas.felder@muenzeoesterreich.at',
      'a.b@sub.domain.co.uk',
      'first+tag@example.com',
    ]) {
      expect(isProvisionableEmail(email)).toBe(true);
    }
  });

  describe('rejects addresses that are not a reachable inbox', () => {
    it('a masked address — Jira returns these when email visibility is hidden', () => {
      expect(isProvisionableEmail('c***@e***.com')).toBe(false);
      expect(isProvisionableEmail('m***.z***@muenzeoesterreich.at')).toBe(
        false,
      );
    });

    it('a synthetic placeholder address', () => {
      expect(
        isProvisionableEmail('mig-abc12345-0123456789ab@placeholder.invalid'),
      ).toBe(false);
    });

    it('anything malformed', () => {
      for (const email of [
        '',
        'not-an-email',
        'no@domain',
        '@example.com',
        'two@@example.com',
        'spaces in@example.com',
        'trailing@example.com ',
      ]) {
        expect(isProvisionableEmail(email)).toBe(false);
      }
    });
  });

  describe('rejects shared mailboxes and service accounts', () => {
    // Every one of these appeared in a real migration roster.
    it.each([
      'administrator@example.com',
      'admin@example.com',
      'jira@example.com',
      'system@example.com',
      'service@example.com',
      'info@example.com',
      'office@example.com',
      'noreply@example.com',
      'test@example.com',
    ])('%s is not a person', (email) => {
      expect(isProvisionableEmail(email)).toBe(false);
    });

    it('is case-insensitive about the local part', () => {
      expect(isProvisionableEmail('ADMINISTRATOR@example.com')).toBe(false);
    });

    it('does not reject a real person whose name merely contains a reserved word', () => {
      expect(isProvisionableEmail('admin.schmidt@example.com')).toBe(true);
      expect(isProvisionableEmail('testa@example.com')).toBe(true);
    });
  });
});
