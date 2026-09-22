/**
 * Reads api-docs/openapi.json into a language-neutral list of SDK operations.
 * Shared by every SDK generator (ts.ts, python.ts), so all SDKs
 * agree on resource names, method names and response shapes.
 *
 * Naming rules (Stripe-style):
 *   - One resource per OpenAPI tag: "Invoice items" → invoiceItems / InvoiceItems.
 *   - The method comes from the operationId's verb:
 *       get|retrieve → retrieve, list → list, create, update, delete → del,
 *       anything else (finalize, send, pay, void, archive…) keeps its name.
 *   - When the operationId names more than the resource (retrieveInvoicePdf,
 *     listInvoiceEvents), the extra part becomes the method: pdf, events.
 *   - METHOD_OVERRIDES wins over all of the above.
 */
import { readFileSync } from 'node:fs'

export type Json = Record<string, unknown>

export interface SpecParam {
  name: string
  required: boolean
  /** The parameter's JSON Schema (may be a $ref). Used by generators that type each param. */
  schema: unknown
}

export type ResponseKind =
  /** 204 / no content. */
  | 'void'
  /** Non-JSON bytes (PDF). */
  | 'binary'
  /** `{ data: [...] , next_cursor? }` → a Page of items. */
  | 'page'
  /** `{ data: X }` → X. */
  | 'data'
  /** `{ data: X, other… }` → the whole body. */
  | 'body'

export interface SpecOperation {
  operationId: string
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  tag: string
  summary: string
  description: string
  scope: string | undefined
  pathParams: string[]
  queryParams: SpecParam[]
  hasBody: boolean
  bodyRequired: boolean
  /** The JSON request body's schema (usually a $ref to components.schemas), if any. */
  bodySchema: unknown
  successStatus: number
  kind: ResponseKind
  /** Schema name of `data` (data) or of each item (page), when it's a $ref. */
  dataRef: string | undefined
  /** Media types of a binary response (sent as Accept). */
  accept?: string
  resource: SpecResource
  sdkMethod: string
}

export interface SpecResource {
  tag: string
  /** Client property: `invoiceItems`. */
  property: string
  /** Plural PascalCase: `InvoiceItems`. */
  plural: string
  /** Singular PascalCase, used for type names: `InvoiceItem`. */
  singular: string
  /** snake_case, for Python: `invoice_items`. */
  snake: string
}

export interface Spec {
  /** The parsed openapi.json, for generators that need schemas the summary doesn't carry. */
  raw: Json
  title: string
  version: string
  schemaNames: string[]
  resources: SpecResource[]
  operations: SpecOperation[]
}

/** operationId → SDK method name, when the rules above pick the wrong one. */
export const METHOD_OVERRIDES: Readonly<Record<string, string>> = {}

/** Tags whose name is already singular. */
const UNCOUNTABLE = new Set(['Business'])

const VERB_MAP: Record<string, string> = { get: 'retrieve', retrieve: 'retrieve', delete: 'del' }

const pascal = (words: string[]) => words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
const camelWords = (s: string) => s.split(/(?=[A-Z])/)
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

function resourceFromTag(tag: string): SpecResource {
  const words = tag.split(/\s+/).map((w) => w.toLowerCase())
  const plural = pascal(words)
  const last = words[words.length - 1]!
  const singularWords = UNCOUNTABLE.has(tag) ? words : [...words.slice(0, -1), last.replace(/s$/, '')]
  return {
    tag,
    property: lowerFirst(plural),
    plural,
    singular: pascal(singularWords),
    snake: words.join('_'),
  }
}

export function methodName(operationId: string, resource: SpecResource): string {
  const override = METHOD_OVERRIDES[operationId]
  if (override) return override
  const [verbRaw, ...rest] = camelWords(operationId)
  const verb = VERB_MAP[verbRaw!] ?? verbRaw!
  const noun = rest.join('')
  if (noun === resource.singular || noun === resource.plural || noun === '') return verb
  for (const prefix of [resource.plural, resource.singular]) {
    if (noun.startsWith(prefix)) {
      const suffix = noun.slice(prefix.length)
      return verb === 'retrieve' || verb === 'list' ? lowerFirst(suffix) : verb + suffix
    }
  }
  throw new Error(
    `sdk-gen: can't derive a method name for ${operationId} under tag "${resource.tag}". Add it to METHOD_OVERRIDES.`,
  )
}

export function deref(spec: Json, node: unknown): Json {
  let n = node as Json
  for (let i = 0; i < 10 && n && typeof n.$ref === 'string'; i++) {
    const parts = (n.$ref as string).replace(/^#\//, '').split('/')
    n = parts.reduce<unknown>((acc, p) => (acc as Json)[p], spec) as Json
  }
  return n
}

export function refName(node: unknown): string | undefined {
  const ref = (node as Json | undefined)?.$ref
  return typeof ref === 'string' ? ref.split('/').pop() : undefined
}

function classify(spec: Json, op: Json): Pick<SpecOperation, 'successStatus' | 'kind' | 'dataRef' | 'accept'> {
  const responses = op.responses as Json
  const status = Object.keys(responses)
    .map(Number)
    .filter((s) => s >= 200 && s < 300)
    .sort((a, b) => a - b)[0]
  if (status === undefined) throw new Error(`sdk-gen: ${String(op.operationId)} has no 2xx response`)
  const response = deref(spec, responses[String(status)])
  const content = response.content as Json | undefined
  if (!content || Object.keys(content).length === 0) return { successStatus: status, kind: 'void', dataRef: undefined }
  const json = content['application/json'] as Json | undefined
  if (!json) return { successStatus: status, kind: 'binary', dataRef: undefined, accept: Object.keys(content).join(', ') }
  const schema = deref(spec, json.schema)
  const props = (schema.properties ?? {}) as Json
  if (!('data' in props)) return { successStatus: status, kind: 'body', dataRef: undefined }
  const data = props.data as Json
  const dataResolved = deref(spec, data)
  if (dataResolved.type === 'array') {
    return { successStatus: status, kind: 'page', dataRef: refName(dataResolved.items) }
  }
  const extras = Object.keys(props).filter((k) => k !== 'data')
  return { successStatus: status, kind: extras.length ? 'body' : 'data', dataRef: refName(data) }
}

export function loadSpec(file: string): Spec {
  const spec = JSON.parse(readFileSync(file, 'utf8')) as Json
  const info = spec.info as Json
  const resources = new Map<string, SpecResource>()
  const operations: SpecOperation[] = []
  const seen = new Set<string>()

  for (const [path, item] of Object.entries(spec.paths as Json)) {
    for (const [m, raw] of Object.entries(item as Json)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(m)) continue
      const op = raw as Json
      const operationId = op.operationId as string | undefined
      if (!operationId) throw new Error(`sdk-gen: ${m.toUpperCase()} ${path} has no operationId`)
      const tag = ((op.tags as string[] | undefined) ?? [])[0]
      if (!tag) throw new Error(`sdk-gen: ${operationId} has no tag`)
      let resource = resources.get(tag)
      if (!resource) {
        resource = resourceFromTag(tag)
        resources.set(tag, resource)
      }
      const params = ((op.parameters as unknown[] | undefined) ?? []).map((p) => deref(spec, p))
      const requestBody = op.requestBody ? deref(spec, op.requestBody) : undefined
      const sdkMethod = methodName(operationId, resource)
      const key = `${resource.property}.${sdkMethod}`
      if (seen.has(key)) throw new Error(`sdk-gen: two operations map to ${key}. Add METHOD_OVERRIDES.`)
      seen.add(key)
      operations.push({
        operationId,
        method: m.toUpperCase() as SpecOperation['method'],
        path,
        tag,
        summary: String(op.summary ?? ''),
        description: String(op.description ?? ''),
        scope: typeof op['x-required-scope'] === 'string' ? (op['x-required-scope'] as string) : undefined,
        pathParams: params.filter((p) => p.in === 'path').map((p) => String(p.name)),
        queryParams: params
          .filter((p) => p.in === 'query')
          .map((p) => ({ name: String(p.name), required: p.required === true, schema: p.schema })),
        hasBody: Boolean((requestBody?.content as Json | undefined)?.['application/json']),
        bodySchema: ((requestBody?.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema,
        bodyRequired: requestBody?.required === true,
        ...classify(spec, op),
        resource,
        sdkMethod,
      })
    }
  }

  return {
    raw: spec,
    title: String(info.title),
    version: String(info.version),
    schemaNames: Object.keys(((spec.components as Json | undefined)?.schemas ?? {}) as Json),
    resources: [...resources.values()],
    operations,
  }
}
