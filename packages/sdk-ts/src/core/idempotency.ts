import { randomUUID } from './crypto'

/**
 * Idempotency, the SDK's half of the contract:
 *
 * - Every POST carries an `Idempotency-Key`. If the caller didn't pass one we
 *   make a UUIDv4.
 * - The key is chosen ONCE per SDK call, before the first attempt, and the
 *   same key goes out on every automatic retry. A retried "create invoice"
 *   therefore replays the stored response instead of creating a second invoice.
 * - PATCH and DELETE don't take keys on this API, so they're only retried when
 *   the request provably never reached the server (see http.ts).
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

/** True for methods the SDK attaches an idempotency key to. */
export function usesIdempotencyKey(method: string): boolean {
  return method.toUpperCase() === 'POST'
}

/** The key for one SDK call: the caller's, or a fresh UUID for POSTs. */
export async function resolveIdempotencyKey(
  method: string,
  userKey: string | undefined,
): Promise<string | undefined> {
  if (userKey !== undefined && userKey !== '') {
    if (userKey.length > 255) throw new RangeError('idempotencyKey must be at most 255 characters')
    return userKey
  }
  return usesIdempotencyKey(method) ? randomUUID() : undefined
}
