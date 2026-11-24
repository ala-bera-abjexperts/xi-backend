/**
 * @fileoverview Process-wide "this on-prem box is read-only" flag.
 * @module on-prem-license/read-only-flag
 *
 * Set by OnpremLicenseStateService whenever it evaluates the licence. Read by
 * background jobs that write data (automations, workflow outbox) so they stop
 * when the licence grace has run out, without every module having to import
 * the on-prem licence module (which only exists on on-prem builds). Always
 * false on SaaS, where nothing ever sets it.
 */

let readOnly = false;

export function setOnPremReadOnly(value: boolean): void {
  readOnly = value;
}

export function isOnPremReadOnly(): boolean {
  return readOnly;
}
