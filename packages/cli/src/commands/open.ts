import type { Command } from 'commander'
import { readConfig } from '../auth/config'
import { profileNameFor, siteUrl } from '../auth/credentials'
import { DOCS_BASE_URL, DOCS_TOPICS } from '../constants'
import type { Ctx } from '../context'
import { usageError } from '../errors'
import type { Act } from './shared'

const PAGES: Record<string, string> = {
  dashboard: '/dashboard',
  invoices: '/dashboard',
  customers: '/customers',
  products: '/products',
  settings: '/settings/business',
  'api-keys': '/settings/api-keys',
  webhooks: '/settings/webhooks',
}

/** Opens a URL in the browser when there's someone to see it; always prints it. */
async function show(ctx: Ctx, url: string): Promise<void> {
  // A bare URL even when piped (`invoice-ai docs api | pbcopy`); JSON only on request.
  if (ctx.explicitJson) {
    ctx.out(JSON.stringify({ url }, null, 2))
    return
  }
  ctx.out(url)
  if (ctx.deps.stderr.isTTY && !ctx.env.CI) {
    await ctx.deps.openUrl(url).catch(() => ctx.warn('Could not open a browser; open the URL above yourself.'))
  }
}

export function registerOpen(program: Command, act: Act): void {
  program
    .command('open [page] [id]')
    .description(`Open the web app: ${Object.keys(PAGES).join(', ')}, or "invoice <id>"`)
    .addHelpText('after', '\nExamples:\n  $ invoice-ai open\n  $ invoice-ai open invoice in_123     # the invoice\'s public page')
    .action(
      act(async (ctx, [page = 'dashboard', id]) => {
        if (page === 'invoice') {
          if (!id) throw usageError('Which invoice?', 'Usage: invoice-ai open invoice <id>')
          const { client, creds } = await ctx.clientWithCreds()
          const invoice = await client.invoices.retrieve(id)
          await show(ctx, `${ctx.site(creds)}/i/${encodeURIComponent(invoice.public_url_token)}`)
          return
        }
        const path = PAGES[page]
        if (!path) throw usageError(`Unknown page "${page}".`, `Use one of: ${Object.keys(PAGES).join(', ')}, or "invoice <id>".`)
        // No API call needed; the profile only tells us which site (prod, local, preview).
        const config = await readConfig(ctx.configDir)
        const profile = config.profiles[profileNameFor(ctx.globals.profile, ctx.env, config)]
        await show(ctx, `${siteUrl(ctx.env.INVOICE_AI_BASE_URL || profile?.base_url)}${path}`)
      }),
    )

  program
    .command('docs [topic]')
    .description(`Open the documentation (${Object.keys(DOCS_TOPICS).join(', ')})`)
    .action(
      act(async (ctx, [topic]) => {
        if (!topic) return show(ctx, `${DOCS_BASE_URL}${DOCS_TOPICS.home}`)
        const path = DOCS_TOPICS[topic.toLowerCase()]
        if (!path) throw usageError(`Unknown docs topic "${topic}".`, `Topics: ${Object.keys(DOCS_TOPICS).join(', ')}.`)
        await show(ctx, `${DOCS_BASE_URL}${path}`)
      }),
    )
}
