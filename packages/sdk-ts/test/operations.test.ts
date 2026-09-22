import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { InvoiceAI, OPERATIONS } from '../src/index'

/**
 * Drift guard: every operationId in the published spec must be reachable as
 * `invoiceai.<resource>.<method>`. If this fails after a spec change, run
 * `pnpm sdk:gen` and commit the result.
 */
const specPath = fileURLToPath(new URL('../../../api-docs/openapi.json', import.meta.url))
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
  info: { version: string }
  paths: Record<string, Record<string, { operationId?: string }>>
}

const specOps = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([m]) => ['get', 'post', 'patch', 'put', 'delete'].includes(m))
    .map(([m, op]) => ({ operationId: op.operationId!, httpMethod: m.toUpperCase(), path })),
)

describe('every operation has an SDK method', () => {
  const client = new InvoiceAI({ apiKey: 'inv_live_ab12cd34_x' }) as unknown as Record<string, Record<string, unknown>>

  it.each(specOps)('$operationId ($httpMethod $path)', ({ operationId, httpMethod, path }) => {
    const entry = OPERATIONS.find((o) => o.operationId === operationId)
    expect(entry, `${operationId} is missing from the generated manifest — run pnpm sdk:gen`).toBeDefined()
    expect(entry!.httpMethod).toBe(httpMethod)
    expect(entry!.path).toBe(path)
    expect(typeof client[entry!.resource]?.[entry!.method]).toBe('function')
  })

  it('the manifest has nothing the spec lacks', () => {
    expect(OPERATIONS.map((o) => o.operationId).sort()).toEqual(specOps.map((o) => o.operationId).sort())
  })

  it('method names are unique per resource and follow the verb conventions', () => {
    const keys = OPERATIONS.map((o) => `${o.resource}.${o.method}`)
    expect(new Set(keys).size).toBe(keys.length)
    const allowed = new Set(['create', 'retrieve', 'update', 'list', 'del', 'archive', 'finalize', 'send', 'pay', 'void', 'pdf', 'events'])
    for (const o of OPERATIONS) expect(allowed, `${o.operationId} → ${o.method}`).toContain(o.method)
  })
})
