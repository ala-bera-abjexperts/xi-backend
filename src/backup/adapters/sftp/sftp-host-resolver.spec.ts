/**
 * @fileoverview Locks the SSRF properties of the SFTP host resolver.
 * @module src/backup/adapters/sftp/sftp-host-resolver.spec
 *
 * These assertions are the control, not documentation of it. The rules that matter:
 * every resolved address is checked, the returned value is an IP literal, and the on-prem escape
 * hatch widens to RFC1918 only — never to loopback or the metadata endpoint.
 */

import { isPermittedAddress, assertValidPort } from './sftp-host-resolver';

describe('isPermittedAddress', () => {
  describe('with the on-prem flag off', () => {
    const allowPrivate = false;

    it.each([
      ['8.8.8.8', true],
      ['1.1.1.1', true],
      ['127.0.0.1', false],
      ['10.0.0.5', false],
      ['172.16.0.1', false],
      ['192.168.1.10', false],
      ['169.254.169.254', false], // cloud metadata
      ['0.0.0.0', false],
      ['100.64.0.1', false], // CGNAT
      ['224.0.0.1', false], // multicast
      ['::1', false],
      ['fe80::1', false],
      ['fc00::1', false],
      ['::ffff:127.0.0.1', false], // IPv4-mapped loopback
      ['not-an-ip', false], // fails closed
    ])('%s → %s', (address, expected) => {
      expect(isPermittedAddress(address, allowPrivate)).toBe(expected);
    });
  });

  describe('with the on-prem flag on', () => {
    const allowPrivate = true;

    it('permits RFC1918 and IPv6 unique-local', () => {
      expect(isPermittedAddress('10.0.0.5', allowPrivate)).toBe(true);
      expect(isPermittedAddress('172.16.0.1', allowPrivate)).toBe(true);
      expect(isPermittedAddress('192.168.1.10', allowPrivate)).toBe(true);
      expect(isPermittedAddress('fc00::1', allowPrivate)).toBe(true);
    });

    it('still refuses loopback, link-local, metadata, CGNAT and multicast', () => {
      // The whole point of the narrow widening: an on-prem customer needs their own LAN, never a
      // path to the host the backend itself runs on.
      expect(isPermittedAddress('127.0.0.1', allowPrivate)).toBe(false);
      expect(isPermittedAddress('169.254.169.254', allowPrivate)).toBe(false);
      expect(isPermittedAddress('fe80::1', allowPrivate)).toBe(false);
      expect(isPermittedAddress('0.0.0.0', allowPrivate)).toBe(false);
      expect(isPermittedAddress('100.64.0.1', allowPrivate)).toBe(false);
      expect(isPermittedAddress('224.0.0.1', allowPrivate)).toBe(false);
      expect(isPermittedAddress('::1', allowPrivate)).toBe(false);
    });

    it('does not permit an IPv4-mapped loopback through the v6 path', () => {
      expect(isPermittedAddress('::ffff:127.0.0.1', allowPrivate)).toBe(false);
    });
  });
});

describe('assertValidPort', () => {
  it('accepts the protocol range, including the routine alternative 2222', () => {
    expect(() => assertValidPort(22)).not.toThrow();
    expect(() => assertValidPort(2222)).not.toThrow();
    expect(() => assertValidPort(65535)).not.toThrow();
  });

  it.each([0, -1, 65536, 1.5, NaN])('rejects %s', (port) => {
    expect(() => assertValidPort(port)).toThrow();
  });
});
