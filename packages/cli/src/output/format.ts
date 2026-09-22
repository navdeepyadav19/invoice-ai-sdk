import Table from 'cli-table3'
import { usageError } from '../errors'
import type { Colors } from '../util/colors'

/**
 * Three output formats:
 *
 * - `table`: for people. The default when stdout is a terminal.
 * - `json`:  the raw API object(s). The default when piped, and `--json`.
 * - `csv`:   one row per object with the table's columns, raw values
 *            (amounts in minor units), for spreadsheets.
 */
export type OutputFormat = 'table' | 'json' | 'csv'

export function resolveFormat(opts: { json?: boolean; format?: string }, stdoutIsTTY: boolean): OutputFormat {
  if (opts.json) return 'json'
  if (opts.format) {
    const f = opts.format.toLowerCase()
    if (f === 'table' || f === 'json' || f === 'csv') return f
    throw usageError(`Unknown --format "${opts.format}".`, 'Use table, json or csv.')
  }
  return stdoutIsTTY ? 'table' : 'json'
}

export interface Column<T> {
  header: string
  /** Raw value, used for CSV. */
  value: (row: T) => unknown
  /** Pretty value for tables. Defaults to the raw value as text. */
  display?: (row: T, c: Colors) => string
}

/** A borderless table in the style of `kubectl get` / `gh`. */
function borderless(head: string[]): InstanceType<typeof Table> {
  return new Table({
    head,
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '', middle: '  ',
    },
    style: { 'padding-left': 0, 'padding-right': 0, head: [], border: [], compact: true },
  })
}

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[], c: Colors): string {
  const table = borderless(columns.map((col) => c.bold(col.header)))
  for (const row of rows) {
    table.push(columns.map((col) => (col.display ? col.display(row, c) : text(col.value(row)))))
  }
  return trimLines(table.toString())
}

/** A key/value table for one object. */
export function renderObject(obj: Record<string, unknown>, c: Colors): string {
  const table = borderless([])
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    table.push([c.dim(key), text(value)])
  }
  return trimLines(table.toString())
}

export function renderCsv<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const lines = [columns.map((col) => csvCell(col.header)).join(',')]
  for (const row of rows) lines.push(columns.map((col) => csvCell(col.value(row))).join(','))
  return lines.join('\n')
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** RFC 4180: quote when needed, double embedded quotes. */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function text(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return value.length ? value.map((v) => text(v)).join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function trimLines(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}
