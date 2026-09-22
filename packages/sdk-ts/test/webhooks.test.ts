import { describe, expect, it } from 'vitest'
import {
  InvoiceAI,
  WebhookVerificationError,
  Webhooks,
  constructEvent,
  signPayload,
  verifySignature,
} from '../src/index'
import { encodeBase64 } from '../src/core/webhooks'

/**
 * The reference vector published with the Standard Webhooks libraries.
 * https://github.com/standard-webhooks/standard-webhooks (test vectors)
 */
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  payload: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}

const headers = (overrides: Record<string, string> = {}) => ({
  'webhook-id': VECTOR.id,
  'webhook-timestamp': String(VECTOR.timestamp),
  'webhook-signature': VECTOR.signature,
  ...overrides,
})
const at = { now: VECTOR.timestamp }

const reject = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(WebhookVerificationError)

describe('verifySignature — reference vector', () => {
  it('accepts the valid vector', async () => {
    await expect(verifySignature(VECTOR.payload, headers(), VECTOR.secret, at)).resolves.toBeUndefined()
  })

  it('accepts Fetch Headers, mixed-case records and byte payloads', async () => {
    await verifySignature(VECTOR.payload, new Headers(headers()), VECTOR.secret, at)
    await verifySignature(
      new TextEncoder().encode(VECTOR.payload),
      { 'Webhook-Id': VECTOR.id, 'Webhook-Timestamp': String(VECTOR.timestamp), 'Webhook-Signature': VECTOR.signature },
      VECTOR.secret,
      at,
    )
  })

  it('rejects a tampered body', async () => {
    await reject(verifySignature('{"test": 2432232315}', headers(), VECTOR.secret, at))
  })

  it('rejects a tampered id or signature', async () => {
    await reject(verifySignature(VECTOR.payload, headers({ 'webhook-id': 'msg_other' }), VECTOR.secret, at))
    await reject(
      verifySignature(VECTOR.payload, headers({ 'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE' }), VECTOR.secret, at),
    )
  })

  it('rejects the wrong secret', async () => {
    await reject(verifySignature(VECTOR.payload, headers(), 'whsec_' + btoa('another secret'), at))
  })

  it('rejects an expired timestamp and one too far in the future (±300s)', async () => {
    await verifySignature(VECTOR.payload, headers(), VECTOR.secret, { now: VECTOR.timestamp + 300 })
    await reject(verifySignature(VECTOR.payload, headers(), VECTOR.secret, { now: VECTOR.timestamp + 301 }))
    await reject(verifySignature(VECTOR.payload, headers(), VECTOR.secret, { now: VECTOR.timestamp - 301 }))
    await verifySignature(VECTOR.payload, headers(), VECTOR.secret, { now: VECTOR.timestamp + 1000, tolerance: 1000 })
  })

  it('accepts any one valid signature among several (secret rotation)', async () => {
    const rotated = `v1,bm90IHRoZSByaWdodCBzaWduYXR1cmUgYXQgYWxsIQ== v2,ignored ${VECTOR.signature}`
    await verifySignature(VECTOR.payload, headers({ 'webhook-signature': rotated }), VECTOR.secret, at)
    await reject(
      verifySignature(VECTOR.payload, headers({ 'webhook-signature': 'v1,bm90IHJpZ2h0 v2,xyz' }), VECTOR.secret, at),
    )
  })

  it('rejects missing headers and non-numeric timestamps', async () => {
    const { 'webhook-signature': _drop, ...noSig } = headers()
    void _drop
    await reject(verifySignature(VECTOR.payload, noSig, VECTOR.secret, at))
    await reject(verifySignature(VECTOR.payload, headers({ 'webhook-timestamp': '16142e5' }), VECTOR.secret, at))
  })

  it('rejects a parsed object instead of the raw body', async () => {
    await reject(verifySignature(JSON.parse(VECTOR.payload) as never, headers(), VECTOR.secret, at))
  })
})

describe('secrets: base64 and base64url', () => {
  // These key bytes encode with '+' and '/' in standard base64, '-' and '_' in base64url.
  const keyBytes = new Uint8Array([251, 255, 191, 62, 63, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252])
  const b64 = encodeBase64(keyBytes)
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  it('the fixture really differs between the alphabets', () => {
    expect(b64).toMatch(/[+/]/)
    expect(b64url).toMatch(/[-_]/)
  })

  it('signatures from a base64 secret verify with the base64url form and vice versa', async () => {
    const payload = '{"id":"evt_1","type":"invoice.paid"}'
    const signed = await signPayload(payload, `whsec_${b64}`, { id: 'msg_1', timestamp: 1_789_371_234 })
    const opts = { now: 1_789_371_234 }
    await verifySignature(payload, signed, `whsec_${b64url}`, opts)
    await verifySignature(payload, signed, `whsec_${b64}`, opts)
    await verifySignature(payload, signed, b64, opts) // prefix optional
  })

  it('rejects a secret that is not base64', async () => {
    await reject(verifySignature(VECTOR.payload, headers(), 'whsec_***not base64***', at))
  })
})

describe('constructEvent', () => {
  const secret = 'whsec_' + btoa('0123456789abcdef0123456789abcdef')
  const event = {
    id: 'evt_0d6c3e9a',
    type: 'invoice.paid',
    created_at: '2026-09-22T09:12:44.123Z',
    data: { object: { id: 'in_1', object: 'invoice', status: 'paid', total: 29500, currency: 'USD' } },
  }

  it('returns the typed event after verifying', async () => {
    const body = JSON.stringify(event)
    const h = await signPayload(body, secret)
    const parsed = await constructEvent(body, h, secret)
    expect(parsed.type).toBe('invoice.paid')
    if (parsed.type === 'invoice.paid') expect(parsed.data.object.id).toBe('in_1')
  })

  it('is available on the client and standalone', async () => {
    const body = JSON.stringify(event)
    const h = await signPayload(body, secret)
    const client = new InvoiceAI({ apiKey: 'inv_live_ab12cd34_x' })
    await expect(client.webhooks.constructEvent(body, h, secret)).resolves.toMatchObject({ id: 'evt_0d6c3e9a' })
    await expect(new Webhooks(secret).constructEvent(body, h)).resolves.toMatchObject({ type: 'invoice.paid' })
    await expect(new Webhooks().constructEvent(body, h)).rejects.toBeInstanceOf(WebhookVerificationError)
  })

  it('rejects a validly signed body that is not JSON', async () => {
    const h = await signPayload('not json', secret)
    await reject(constructEvent('not json', h, secret))
  })
})
