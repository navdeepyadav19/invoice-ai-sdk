import type { Command } from 'commander'
import { InvoiceAI } from '@horizonpay/invoice-ai'
import { readConfig, writeConfig } from '../auth/config'
import {
  assertKeyShape,
  keyPrefix,
  profileNameFor,
  readProfileSecret,
  removeProfile,
  saveProfile,
  siteUrl,
} from '../auth/credentials'
import { pollForToken, requestDeviceCode, revokeSession } from '../auth/device-flow'
import { DEFAULT_SITE_URL } from '../constants'
import type { Ctx } from '../context'
import { usageError } from '../errors'
import type { Act } from './shared'

const API_SUFFIX = '/api/v1'

export function registerAuth(program: Command, act: Act): void {
  program
    .command('login')
    .description('Log in with your browser (or store a key passed with --api-key)')
    .option('--no-browser', "print the login URL instead of opening a browser")
    .addHelpText(
      'after',
      '\nOpens the Invoice-AI authorize page, where you approve this device. A new API key\nis created for it and saved in your OS keychain (or ~/.config/invoice-ai/config.json,\nmode 0600, when no keychain is available).\n\nExamples:\n  $ invoice-ai login\n  $ invoice-ai login --profile staging\n  $ invoice-ai login --api-key inv_live_…        # no browser; verifies and stores the key',
    )
    .action(act<{ browser: boolean }>(async (ctx, _args, opts) => login(ctx, opts.browser)))

  program
    .command('logout')
    .description('Revoke this profile’s key on the server and forget it locally')
    .action(act(async (ctx) => logout(ctx)))

  program
    .command('whoami')
    .description('Show the account, key and profile in use')
    .action(act(async (ctx) => whoami(ctx)))

  program
    .command('switch [profile]')
    .description('Make another logged-in profile the default (lists profiles without an argument)')
    .action(act(async (ctx, [name]) => switchProfile(ctx, name)))
}

async function currentProfileName(ctx: Ctx): Promise<string> {
  return profileNameFor(ctx.globals.profile, ctx.env, await readConfig(ctx.configDir))
}

/** API base for a new profile: INVOICE_AI_BASE_URL if set (local dev, previews). */
function envBase(ctx: Ctx): string | undefined {
  return ctx.env.INVOICE_AI_BASE_URL || undefined
}

async function login(ctx: Ctx, browser: boolean): Promise<void> {
  const profileName = ctx.globals.profile || ctx.env.INVOICE_AI_PROFILE || 'default'
  const base = envBase(ctx)
  const site = siteUrl(base)

  // --api-key: no browser. Verify the key with a real call, then store it.
  if (ctx.globals.apiKey) {
    assertKeyShape(ctx.globals.apiKey, '--api-key')
    const client = new InvoiceAI({ apiKey: ctx.globals.apiKey, fetch: ctx.deps.fetch, logLevel: 'off', ...(base ? { baseURL: base } : {}) })
    const business = await client.business.retrieve()
    const profile = await saveProfile({
      name: profileName,
      apiKey: ctx.globals.apiKey,
      meta: { email: business.email, business_name: business.trade_name ?? business.legal_name, ...(base ? { base_url: base } : {}) },
      configDir: ctx.configDir,
      secrets: ctx.secrets,
      now: new Date(ctx.deps.now()),
    })
    reportLogin(ctx, profileName, profile.storage, business.email, profile.business_name ?? null)
    return
  }

  const flow = { fetch: ctx.deps.fetch, sleep: ctx.deps.sleep, now: ctx.deps.now }
  const device = await requestDeviceCode(flow, site, {
    name: ctx.deps.hostname(),
    os: `${ctx.deps.platform} ${ctx.deps.arch}`,
  })

  ctx.info('')
  ctx.info(`  Your one-time code: ${ctx.ce.bold(ctx.ce.cyan(device.user_code))}`)
  ctx.info('')
  const canOpen = browser && Boolean(ctx.deps.stderr.isTTY) && !ctx.env.CI
  if (canOpen) {
    ctx.info(`  Opening ${device.verification_uri_complete}`)
    ctx.info(ctx.ce.dim("  If the browser doesn't open, visit the URL above and enter the code."))
    await ctx.deps.openUrl(device.verification_uri_complete).catch(() => {
      ctx.warn('Could not open a browser; open the URL above yourself.')
    })
  } else {
    ctx.info(`  Visit ${device.verification_uri_complete}`)
    ctx.info(ctx.ce.dim(`  (or ${device.verification_uri} and enter the code) to approve this device.`))
  }
  ctx.info('')

  const spinner = ctx.spinner()
  const expiresAt = ctx.deps.now() + device.expires_in * 1000
  const remaining = () => Math.max(0, Math.round((expiresAt - ctx.deps.now()) / 1000))
  spinner.start('Waiting for you to approve in the browser…')
  let token
  try {
    token = await pollForToken(flow, {
      site,
      deviceCode: device.device_code,
      interval: device.interval,
      expiresIn: device.expires_in,
      onPoll: (e) => {
        const left = remaining()
        const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
        spinner.update(
          e.outcome === 'retry'
            ? `Server busy, retrying… (code expires in ${mmss})`
            : `Waiting for you to approve in the browser… (code expires in ${mmss})`,
        )
      },
    })
  } catch (err) {
    spinner.stop()
    throw err
  }
  spinner.stop()

  const profile = await saveProfile({
    name: profileName,
    apiKey: token.api_key,
    meta: {
      key_id: token.key_id || null,
      scopes: token.scopes,
      email: token.account.email,
      business_name: token.account.business_name,
      ...(base ? { base_url: base } : {}),
    },
    configDir: ctx.configDir,
    secrets: ctx.secrets,
    now: new Date(ctx.deps.now()),
  })
  reportLogin(ctx, profileName, profile.storage, token.account.email, token.account.business_name)
}

function reportLogin(ctx: Ctx, profileName: string, storage: 'keychain' | 'file', email: string | null | undefined, business: string | null): void {
  const who = [email, business ? `(${business})` : null].filter(Boolean).join(' ') || 'your account'
  if (ctx.format === 'json') {
    ctx.out(JSON.stringify({ profile: profileName, email: email ?? null, business_name: business, storage }, null, 2))
    return
  }
  ctx.success(`Logged in as ${who}`)
  const where = storage === 'keychain' ? ctx.secrets.label : `${ctx.configDir}/config.json (mode 0600)`
  ctx.info(ctx.ce.dim(`  Profile "${profileName}" · key stored in ${where}`))
  ctx.info(ctx.ce.dim('  Try: invoice-ai invoices list'))
}

async function logout(ctx: Ctx): Promise<void> {
  const name = await currentProfileName(ctx)
  const config = await readConfig(ctx.configDir)
  const profile = config.profiles[name]
  if (!profile) {
    if (ctx.globals.apiKey || ctx.env.INVOICE_AI_API_KEY) {
      ctx.info('Nothing to log out of: the key comes from --api-key / INVOICE_AI_API_KEY, which the CLI never stores.')
    } else {
      ctx.info(`Not logged in${name === 'default' ? '' : ` (profile "${name}")`}.`)
    }
    return
  }
  const apiKey = await readProfileSecret(name, profile, ctx.secrets)
  if (apiKey) {
    const site = siteUrl(ctx.env.INVOICE_AI_BASE_URL || profile.base_url)
    const result = await revokeSession({ fetch: ctx.deps.fetch }, site, apiKey)
    if (typeof result === 'object') {
      ctx.warn(`Could not revoke the key on the server (${result.failed}). Revoke ${profile.key_prefix} in Settings → API keys.`)
    }
  }
  await removeProfile(name, ctx.configDir, ctx.secrets)
  ctx.success(`Logged out${name === 'default' ? '' : ` of profile "${name}"`}.`)
}

async function whoami(ctx: Ctx): Promise<void> {
  const { client, creds } = await ctx.clientWithCreds()
  const business = await client.business.retrieve()
  const info = {
    business: business.trade_name ?? business.legal_name,
    legal_name: business.legal_name,
    email: creds.profile?.email ?? business.email,
    business_id: business.id,
    currency: business.currency,
    profile: creds.source === 'profile' ? creds.profileName : null,
    key_source: creds.source === 'flag' ? '--api-key' : creds.source === 'env' ? 'INVOICE_AI_API_KEY' : `profile (${creds.profile?.storage === 'file' ? 'config file' : 'keychain'})`,
    key: keyPrefix(creds.apiKey),
    scopes: creds.profile?.scopes ?? null,
    api: creds.baseURL ?? `${DEFAULT_SITE_URL}${API_SUFFIX}`,
  }
  ctx.printObject(info)
}

async function switchProfile(ctx: Ctx, name: string | undefined): Promise<void> {
  const config = await readConfig(ctx.configDir)
  const names = Object.keys(config.profiles)
  if (names.length === 0) throw usageError('No profiles yet.', 'Run `invoice-ai login` (add --profile <name> for more than one).')

  if (!name) {
    if (ctx.interactive) {
      const p = await import('@clack/prompts')
      const picked = await p.select<string>({
        message: 'Switch to profile',
        initialValue: config.active_profile,
        options: names.map((n) => ({ value: n, label: n, hint: describe(config.profiles[n]!) })),
      })
      if (p.isCancel(picked)) return
      name = picked
    } else {
      const rows = names.map((n) => ({ profile: n, active: n === (config.active_profile ?? 'default'), ...pick(config.profiles[n]!) }))
      if (ctx.format === 'json') return ctx.out(JSON.stringify(rows, null, 2))
      for (const r of rows) ctx.out(`${r.active ? '*' : ' '} ${r.profile}  ${ctx.c.dim(describe(config.profiles[r.profile]!))}`)
      return
    }
  }
  if (!config.profiles[name]) {
    throw usageError(`No profile named "${name}".`, `Profiles: ${names.join(', ')}. Create one with \`invoice-ai login --profile ${name}\`.`)
  }
  config.active_profile = name
  await writeConfig(ctx.configDir, config)
  ctx.success(`Now using profile "${name}" (${describe(config.profiles[name]!)})`)
}

function pick(p: { email?: string | null; business_name?: string | null; key_prefix: string; base_url?: string }) {
  return { email: p.email ?? null, business_name: p.business_name ?? null, key: p.key_prefix, base_url: p.base_url ?? null }
}

function describe(p: { email?: string | null; business_name?: string | null; key_prefix: string; base_url?: string }): string {
  return [p.email, p.business_name, p.key_prefix, p.base_url].filter(Boolean).join(' · ')
}
