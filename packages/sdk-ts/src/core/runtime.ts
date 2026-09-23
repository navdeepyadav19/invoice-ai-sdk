/**
 * Runtime detection that never touches Node-only globals directly, so the SDK
 * loads unchanged in Node 20+, Bun, Deno, browsers and edge runtimes.
 */

interface ProcessLike {
  env?: Record<string, string | undefined>
  versions?: { node?: string; bun?: string }
  platform?: string
  arch?: string
}

function processLike(): ProcessLike | undefined {
  const p = (globalThis as { process?: ProcessLike }).process
  return typeof p === 'object' && p !== null ? p : undefined
}

/** Reads an environment variable where one exists (Node, Bun, Deno's process shim). */
export function readEnv(name: string): string | undefined {
  const value = processLike()?.env?.[name]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  const deno = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno
  try {
    const v = deno?.env?.get?.(name)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  } catch {
    return undefined // Deno without --allow-env
  }
}

/** `node 22.3.0; darwin arm64`, or a generic label outside Node. */
export function platformLabel(): string {
  const p = processLike()
  if (p?.versions?.bun) return `bun ${p.versions.bun}`
  if (p?.versions?.node) return `node ${p.versions.node}; ${p.platform ?? 'unknown'} ${p.arch ?? ''}`.trim()
  if ((globalThis as { Deno?: unknown }).Deno) return 'deno'
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime === 'string') return 'edge'
  return 'unknown'
}

/** Browsers forbid setting User-Agent; everywhere else we set it. */
export function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown }
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined'
}
