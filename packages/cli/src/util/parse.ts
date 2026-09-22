import { readFile } from 'node:fs/promises'
import { InvalidArgumentError } from 'commander'
import { usageError } from '../errors'

/** Commander reducer for repeatable options: `--price a --price b`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

export function parsePositiveInt(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('Expected a positive whole number.')
  return n
}

export function parseNonNegativeInt(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Expected a whole number (0 or more).')
  return n
}

export function parsePositiveNumber(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('Expected a positive number.')
  return n
}

export function parseBool(value: string): boolean {
  const v = value.toLowerCase()
  if (['true', 'yes', '1'].includes(v)) return true
  if (['false', 'no', '0'].includes(v)) return false
  throw new InvalidArgumentError('Expected true or false.')
}

/**
 * `--data` accepts inline JSON, `@file.json`, or `@-` for stdin.
 */
export async function readDataArg(value: string, readStdin: () => Promise<string>): Promise<unknown> {
  let raw = value
  let where = '--data'
  if (value === '@-') {
    raw = await readStdin()
    where = 'stdin'
  } else if (value.startsWith('@')) {
    const path = value.slice(1)
    try {
      raw = await readFile(path, 'utf8')
    } catch (e) {
      throw usageError(`Could not read ${path}: ${(e as Error).message}`)
    }
    where = path
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw usageError(`${where} is not valid JSON: ${(e as Error).message}`)
  }
}

/** Like readDataArg, but the JSON must be an object (a request body). */
export async function readDataObject(
  value: string | undefined,
  readStdin: () => Promise<string>,
): Promise<Record<string, unknown>> {
  if (value === undefined) return {}
  const data = await readDataArg(value, readStdin)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw usageError('--data must be a JSON object.')
  return data as Record<string, unknown>
}

/** `--query status=open --query limit=5` → `{ status: 'open', limit: '5' }`; repeats become arrays. */
export function parseQueryPairs(pairs: readonly string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw usageError(`--query expects key=value, got "${pair}".`)
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    const prev = out[key]
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
  }
  return out
}

/** Drops undefined values so flags that weren't passed don't overwrite --data. */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
