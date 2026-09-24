/**
 * How many decimals each currency has — the one table the wire format, the
 * UI and the webhook payload (supabase/migrations/0014_webhook_payload_v2.sql)
 * all agree on.
 *
 * A fixed table, not `Intl`. Intl's answer comes from whatever ICU build the
 * runtime ships (browser, Node, edge), and CLDR rounds some currencies for
 * display (it calls IDR and HUF zero-decimal). A wire contract can't change
 * with the runtime, so this follows ISO 4217's minor units, like Stripe:
 *
 *   JPY 5000 on the wire is ¥5,000       (0 decimals)
 *   USD 2500 on the wire is $25.00       (2 decimals — the default)
 *   KWD 1500 on the wire is 1.500 KWD    (3 decimals)
 *
 * Pure and dependency-free: safe to import from client components.
 */

/** ISO 4217 currencies with no minor unit. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

/** ISO 4217 currencies with three decimals. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])

/** How many decimals a currency uses: USD 2, JPY 0, KWD 3. Unknown codes get 2. */
export function currencyDecimals(currency: string): number {
  const code = currency.toUpperCase()
  if (ZERO_DECIMAL.has(code)) return 0
  if (THREE_DECIMAL.has(code)) return 3
  return 2
}

/**
 * Amounts are stored as numeric(14,2), so a three-decimal currency can only
 * hold whole hundredths (1.230 KWD, not 1.234). This is the number of decimals
 * that survive storage.
 */
export const STORED_DECIMALS = 2

/**
 * A major-unit amount (a stored numeric, or a JS number) → integer minor units
 * for the wire: `majorToMinor('25.00', 'USD')` is 2500, `majorToMinor(5000, 'JPY')`
 * is 5000.
 */
export function majorToMinor(major: number | string, currency: string): number {
  const value = Number(major) * 10 ** currencyDecimals(currency)
  // Half away from zero, like Math.round for positives; symmetric for credits.
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Integer minor units from the wire → a major-unit amount: 2500 USD is 25. */
export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDecimals(currency)
}

/**
 * Whether a wire amount can be stored exactly. Only three-decimal currencies
 * can fail: 1234 fils is 1.234 KWD, which numeric(14,2) cannot hold.
 */
export function isStorableMinor(minor: number, currency: string): boolean {
  const extra = currencyDecimals(currency) - STORED_DECIMALS
  return extra <= 0 || minor % 10 ** extra === 0
}
