import type { Command } from 'commander'
import type { PagePromise } from '@horizonpay/invoice-ai'
import type { Ctx } from '../context'
import type { Column } from '../output/format'
import { parsePositiveInt } from '../util/parse'

/** Wraps a handler as a commander action: builds the Ctx from the command. */
export type Act = <O = Record<string, unknown>>(
  handler: (ctx: Ctx, args: string[], opts: O) => Promise<void>,
) => (...all: unknown[]) => Promise<void>

export interface ListOptions {
  limit?: number
  cursor?: string
  all?: boolean
}

export function withListOptions(cmd: Command): Command {
  return cmd
    .option('--limit <n>', 'results per page (1-100)', parsePositiveInt)
    .option('--cursor <cursor>', 'start after this cursor (from a previous page)')
    .option('--all', 'fetch every page, not just the first')
}

export function pageParams(opts: ListOptions): { limit?: number; cursor?: string } {
  return {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.cursor ? { cursor: opts.cursor } : {}),
  }
}

/** One page, or with --all every page (the SDK walks the cursors). */
export async function runList<T>(ctx: Ctx, pending: PagePromise<T>, columns: Column<T>[], opts: ListOptions): Promise<void> {
  if (opts.all) {
    const rows = await pending.toArray()
    ctx.printList(rows, columns, null)
    return
  }
  const page = await pending
  ctx.printList(page.data, columns, page.nextCursor)
}

/** Adds the `--data <json|@file|@->` option used by create/update commands. */
export function withData(cmd: Command): Command {
  return cmd.option('-d, --data <json>', 'request body as JSON, @file.json or @- for stdin (flags override its fields)')
}
