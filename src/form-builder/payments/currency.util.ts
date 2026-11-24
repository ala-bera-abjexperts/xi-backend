//
// Single source of truth for Stripe money conversion. Kept out of the services so the checkout path
// and the Stripe-catalog sync can never drift apart on zero-decimal currencies.

export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

// Major units (dollars) → Stripe minor units (cents).
export function toMinorUnits(major: number, currency: string): number {
  const amount = Number(major) || 0;

  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()))
    return Math.round(amount);

  return Math.round(amount * 100);
}

// Stripe minor units → major units, for showing a Stripe price in the builder.
export function toMajorUnits(minor: number, currency: string): number {
  const amount = Number(minor) || 0;

  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) return amount;

  return amount / 100;
}
