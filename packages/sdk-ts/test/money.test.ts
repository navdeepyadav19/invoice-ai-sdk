import { describe, expect, it } from 'vitest'
import { currencyDecimals, formatMoney, fromMinor, toMinor } from '../src/index'

describe('money', () => {
  it('knows each currency’s decimals', () => {
    expect(currencyDecimals('USD')).toBe(2)
    expect(currencyDecimals('inr')).toBe(2)
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('KRW')).toBe(0)
    expect(currencyDecimals('KWD')).toBe(3)
    expect(currencyDecimals('BHD')).toBe(3)
    expect(() => currencyDecimals('US')).toThrow(RangeError)
  })

  it('agrees with Intl for the currencies it lists', () => {
    for (const c of ['USD', 'EUR', 'INR', 'JPY', 'KRW', 'VND', 'KWD', 'BHD', 'OMR', 'JOD', 'TND']) {
      const intl = new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits
      expect([c, currencyDecimals(c)]).toEqual([c, intl])
    }
  })

  it('toMinor converts exactly, without float error', () => {
    expect(toMinor('25.00', 'USD')).toBe(2500)
    expect(toMinor('0.29', 'USD')).toBe(29) // 0.29 * 100 = 28.999999999999996 in floats
    expect(toMinor(19.99, 'USD')).toBe(1999)
    expect(toMinor('1,234.5', 'USD')).toBe(123450)
    expect(toMinor('5000', 'JPY')).toBe(5000)
    expect(toMinor('1.234', 'KWD')).toBe(1234)
    expect(toMinor('-3.5', 'USD')).toBe(-350)
    expect(toMinor('.5', 'USD')).toBe(50)
    expect(toMinor('7.000', 'JPY')).toBe(7) // trailing zeros are fine
  })

  it('toMinor refuses to round silently', () => {
    expect(() => toMinor('1.234', 'USD')).toThrow(RangeError)
    expect(() => toMinor('10.5', 'JPY')).toThrow(RangeError)
    expect(() => toMinor('abc', 'USD')).toThrow(RangeError)
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(RangeError)
    expect(() => toMinor('.', 'USD')).toThrow(RangeError)
  })

  it('fromMinor gives an exact decimal string', () => {
    expect(fromMinor(2500, 'USD')).toBe('25.00')
    expect(fromMinor(5, 'USD')).toBe('0.05')
    expect(fromMinor(-350, 'USD')).toBe('-3.50')
    expect(fromMinor(5000, 'JPY')).toBe('5000')
    expect(fromMinor(1234, 'KWD')).toBe('1.234')
    expect(fromMinor(BigInt('900719925474099312'), 'USD')).toBe('9007199254740993.12')
    expect(() => fromMinor(1.5, 'USD')).toThrow(RangeError)
  })

  it('round-trips', () => {
    for (const [amount, c] of [['25.00', 'USD'], ['5000', 'JPY'], ['1.234', 'KWD']] as const) {
      expect(fromMinor(toMinor(amount, c), c)).toBe(amount)
    }
  })

  it('formatMoney uses the currency’s own decimals', () => {
    expect(formatMoney(2500, 'USD')).toBe('$25.00')
    expect(formatMoney(5000, 'JPY')).toBe('¥5,000')
    expect(formatMoney(1234, 'KWD', { currencyDisplay: 'code' })).toMatch(/^KWD\s1\.234$/)
    expect(formatMoney(250000, 'INR', { locale: 'en-IN' })).toBe('₹2,500.00')
  })
})
