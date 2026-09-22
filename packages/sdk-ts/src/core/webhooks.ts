import type { Invoice, InvoiceEvent } from '../generated/types'
import { getCrypto } from './crypto'
import { WebhookVerificationError } from './errors'

/**
 * Standard Webhooks verification (https://www.standardwebhooks.com).
 *
 *   const event = await invoiceai.webhooks.constructEvent(rawBody, req.headers, secret)
 *   if (event.type === 'invoice.paid') fulfil(event.data.object)
 *
 * Checks, in order:
 *   1. `webhook-id`, `webhook-timestamp` and `webhook-signature` are present;
 *   2. the timestamp is within ±`tolerance` seconds (default 300) of now;
 *   3. HMAC-SHA256 over `{id}.{timestamp}.{raw body}` with the secret's bytes
 *      matches one of the space-separated `v1,<base64>` signatures (several
 *      appear while a secret is being rotated), compared in constant time.
 *
 * Secrets look like `whsec_<base64>`; older endpoints were issued base64url
 * secrets, and both decode correctly here.
 *
 * Verify the RAW body. A body that was JSON-parsed and re-serialised won't match.
 */

/** Every event type the API emits. */
export type WebhookEventType = InvoiceEvent['type']

/** A verified webhook delivery. `data.object` is the invoice as of the event. */
export interface WebhookEvent<T extends WebhookEventType = WebhookEventType> {
  /** Event id; the same on every endpoint and every retry. Deduplicate on it. */
  id: string
  type: T
  /** ISO 8601 time the event happened. */
  created_at: string
  data: { object: Invoice }
}

export type InvoiceCreatedEvent = WebhookEvent<'invoice.created'>
export type InvoiceUpdatedEvent = WebhookEvent<'invoice.updated'>
export type InvoiceFinalizedEvent = WebhookEvent<'invoice.finalized'>
export type InvoiceEmailedEvent = WebhookEvent<'invoice.emailed'>
export type InvoiceEmailFailedEvent = WebhookEvent<'invoice.email_failed'>
export type InvoiceViewedEvent = WebhookEvent<'invoice.viewed'>
export type InvoiceDownloadedEvent = WebhookEvent<'invoice.downloaded'>
export type InvoicePaidEvent = WebhookEvent<'invoice.paid'>
export type InvoiceVoidedEvent = WebhookEvent<'invoice.voided'>

/** A discriminated union: `switch (event.type)` narrows it. */
export type AnyWebhookEvent = { [K in WebhookEventType]: WebhookEvent<K> }[WebhookEventType]

/** Headers as a Fetch `Headers`, or a Node/Express-style object. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>

export type WebhookPayload = string | Uint8Array | ArrayBuffer

export interface VerifyOptions {
  /** Allowed clock skew in seconds, either direction. Default 300. */
  tolerance?: number
  /** Unix seconds to treat as "now" (tests). */
  now?: number
}

export const DEFAULT_TOLERANCE_SECONDS = 300

const encoder = new TextEncoder()

function header(headers: WebhookHeaders, name: string): string | undefined {
  // Fetch Headers (or a Headers-like object from another realm).
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as Headers).get(name) ?? undefined
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(' ') : v
  }
  return undefined
}

function toBytes(payload: WebhookPayload): Uint8Array {
  if (typeof payload === 'string') return encoder.encode(payload)
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  throw new WebhookVerificationError(
    'The webhook payload must be the raw body (string, Uint8Array or ArrayBuffer), not a parsed object.',
  )
}

/** Decodes standard base64 or base64url, with or without padding. */
export function decodeBase64(input: string): Uint8Array {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) {
    throw new WebhookVerificationError('Invalid base64')
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

/** The key bytes of a `whsec_…` secret (base64 or base64url). */
export function secretKeyBytes(secret: string): Uint8Array {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new WebhookVerificationError('Missing webhook signing secret.')
  }
  const raw = secret.trim().replace(/^whsec_/, '')
  try {
    const bytes = decodeBase64(raw)
    if (bytes.length === 0) throw new Error('empty')
    return bytes
  } catch {
    throw new WebhookVerificationError('The webhook secret is not valid base64. Copy it exactly as issued (whsec_…).')
  }
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const { subtle } = await getCrypto()
  const cryptoKey = await subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await subtle.sign('HMAC', cryptoKey, data as BufferSource))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Constant-time comparison. Lengths aren't secret (an HMAC-SHA256 is always 32 bytes). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

async function computeSignature(secret: string, id: string, timestamp: string, payload: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(secretKeyBytes(secret), concat(encoder.encode(`${id}.${timestamp}.`), payload))
}

/**
 * Checks a delivery's signature and timestamp. Resolves if valid, rejects with
 * `WebhookVerificationError` otherwise.
 */
export async function verifySignature(
  payload: WebhookPayload,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): Promise<void> {
  const id = header(headers, 'webhook-id')
  const timestamp = header(headers, 'webhook-timestamp')
  const signatureHeader = header(headers, 'webhook-signature')
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header.')
  }

  const ts = Number(timestamp)
  if (!/^\d+$/.test(timestamp.trim()) || !Number.isSafeInteger(ts)) {
    throw new WebhookVerificationError('Invalid webhook-timestamp header.')
  }
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (now - ts > tolerance) throw new WebhookVerificationError('Webhook timestamp is too old.')
  if (ts - now > tolerance) throw new WebhookVerificationError('Webhook timestamp is too far in the future.')

  const mac = await computeSignature(secret, id, timestamp.trim(), toBytes(payload))
  const expected = encoder.encode(`v1,${encodeBase64(mac)}`)
  let matched = false
  for (const part of signatureHeader.split(' ')) {
    if (!part.startsWith('v1,')) continue // other schemes (v1a…) aren't ours
    // Compare the exact encoded string, as the reference implementations do.
    // Don't short-circuit: check every signature so timing doesn't reveal which matched.
    if (timingSafeEqual(encoder.encode(part), expected)) matched = true
  }
  if (!matched) throw new WebhookVerificationError('No matching webhook signature found.')
}

/**
 * Verifies a delivery and returns its parsed, typed event.
 * Throws `WebhookVerificationError` if the signature, timestamp or JSON is bad.
 */
export async function constructEvent(
  payload: WebhookPayload,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): Promise<AnyWebhookEvent> {
  await verifySignature(payload, headers, secret, options)
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(toBytes(payload))
  let event: unknown
  try {
    event = JSON.parse(text)
  } catch {
    throw new WebhookVerificationError('Webhook body is not valid JSON.')
  }
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
    throw new WebhookVerificationError('Webhook body is not an event object.')
  }
  return event as AnyWebhookEvent
}

export interface SignOptions {
  /** Delivery id. Default: a random UUID-like id. */
  id?: string
  /** Unix seconds. Default: now. */
  timestamp?: number
}

/**
 * Signs a payload the way Invoice-AI does, returning the three headers.
 * Useful for testing your handler locally.
 */
export async function signPayload(
  payload: WebhookPayload,
  secret: string,
  options: SignOptions = {},
): Promise<{ 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string }> {
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000))
  const sig = await computeSignature(secret, id, timestamp, toBytes(payload))
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${encodeBase64(sig)}` }
}

/** `invoiceai.webhooks` — also usable without an API key via `new Webhooks()`. */
export class Webhooks {
  constructor(private readonly defaultSecret?: string) {}

  /** Verifies and parses a delivery. `secret` defaults to the one given to the constructor. */
  async constructEvent(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret?: string,
    options?: VerifyOptions,
  ): Promise<AnyWebhookEvent> {
    return constructEvent(payload, headers, this.secret(secret), options)
  }

  /** Verifies a delivery without parsing it. */
  async verifySignature(
    payload: WebhookPayload,
    headers: WebhookHeaders,
    secret?: string,
    options?: VerifyOptions,
  ): Promise<void> {
    return verifySignature(payload, headers, this.secret(secret), options)
  }

  /** Produces signed headers for a payload (for local testing). */
  async sign(payload: WebhookPayload, secret?: string, options?: SignOptions) {
    return signPayload(payload, this.secret(secret), options)
  }

  private secret(secret: string | undefined): string {
    const s = secret ?? this.defaultSecret
    if (!s) throw new WebhookVerificationError('Pass the endpoint signing secret (whsec_…).')
    return s
  }
}
