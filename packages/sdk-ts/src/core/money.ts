/**
 * Money helpers. Every amount on the wire is an integer in the currency's
 * smallest unit (Stripe-style): 2500 is $25.00, 2500 is ¥2,500, 2500 is
 * KWD 2.500. These helpers convert with each currency's ISO 4217 exponent —
 * the same numbers `Intl` (and therefore the server) uses — without ever
 * going through floating-point multiplication.
 */

/** Currencies whose minor unit isn't 1/100. Everything else has 2 decimals. */
const DECIMALS: Readonly<Record<string, number>> = {
  // Zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal
  CLF: 4, UYW: 4,
}

/** How many decimals a currency uses: USD 2, JPY 0, KWD 3. */
export function currencyDecimals(currency: string): number {
  const code = currency.toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new RangeError(`Not an ISO 4217 currency code: ${currency}`)
  return DECIMALS[code] ?? 2
}

/**
 * A major-unit amount to integer minor units.
 *   toMinor('25.00', 'USD') → 2500     toMinor(5000, 'JPY') → 5000
 *   toMinor('1.234', 'KWD') → 1234     toMinor('1.234', 'USD') → RangeError
 * Throws instead of rounding when the amount has more decimals than the currency.
 */
export function toMinor(amount: string | number, currency: string): number {
  const decimals = currencyDecimals(currency)
  let text: string
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new RangeError(`Amount must be finite, got ${amount}`)
    text = String(amount)
    if (/e/i.test(text)) text = amount.toFixed(Math.max(decimals, 0))
  } else {
    text = amount.trim().replace(/[,_\s]/g, '')
  }
  const m = text.match(/^([+-]?)(\d*)(?:\.(\d*))?$/)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`Not a decimal amount: ${String(amount)}`)
  const [, sign, whole = '', fracRaw = ''] = m
  const frac = fracRaw.replace(/0+$/, '')
  if (frac.length > decimals) {
    throw new RangeError(`${currency.toUpperCase()} allows ${decimals} decimal place(s); got ${String(amount)}`)
  }
  const digits = (whole || '0') + frac.padEnd(decimals, '0')
  const value = Number(digits)
  if (!Number.isSafeInteger(value)) throw new RangeError(`Amount is too large: ${String(amount)}`)
  return sign === '-' && value !== 0 ? -value : value
}

/**
 * Integer minor units to an exact major-unit decimal string.
 *   fromMinor(2500, 'USD') → '25.00'   fromMinor(5000, 'JPY') → '5000'   fromMinor(1234, 'KWD') → '1.234'
 */
export function fromMinor(minor: number | bigint, currency: string): string {
  const decimals = currencyDecimals(currency)
  if (typeof minor === 'number' && !Number.isInteger(minor)) {
    throw new RangeError(`Minor units must be an integer, got ${minor}`)
  }
  const n = BigInt(minor)
  const negative = n < BigInt(0)
  const digits = (negative ? -n : n).toString()
  if (decimals === 0) return (negative ? '-' : '') + digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const frac = padded.slice(-decimals)
  return `${negative ? '-' : ''}${whole}.${frac}`
}

export interface FormatMoneyOptions {
  /** BCP 47 locale. Default `en-US`. */
  locale?: string
  /** `symbol` ($), `narrowSymbol`, `code` (USD) or `name`. Default `symbol`. */
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name'
}

/**
 * Minor units formatted for people.
 *   formatMoney(2500, 'USD') → '$25.00'   formatMoney(5000, 'JPY') → '¥5,000'
 */
export function formatMoney(minor: number | bigint, currency: string, options: FormatMoneyOptions = {}): string {
  const decimals = currencyDecimals(currency)
  const major = fromMinor(minor, currency)
  try {
    return new Intl.NumberFormat(options.locale ?? 'en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      currencyDisplay: options.currencyDisplay ?? 'symbol',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(major))
  } catch {
    return `${currency.toUpperCase()} ${major}`
  }
}
