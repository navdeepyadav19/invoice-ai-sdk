/**
 * Web Crypto access. Node 19+, Bun, Deno, browsers and edge runtimes expose
 * `globalThis.crypto`; Node 18 only has it on `node:crypto`'s `webcrypto`,
 * which we load lazily so bundlers for edge targets never see the import.
 */

let cached: Crypto | undefined

export async function getCrypto(): Promise<Crypto> {
  if (cached) return cached
  const global = (globalThis as { crypto?: Crypto }).crypto
  if (global?.subtle) {
    cached = global
    return cached
  }
  // A variable specifier keeps bundlers from trying to resolve Node built-ins.
  const specifier = 'node:crypto'
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
    webcrypto?: Crypto
  }
  if (!mod.webcrypto?.subtle) throw new Error('invoice-ai: no Web Crypto implementation is available')
  cached = mod.webcrypto
  return cached
}

/** A random RFC 4122 v4 UUID. */
export async function randomUUID(): Promise<string> {
  const c = await getCrypto()
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
