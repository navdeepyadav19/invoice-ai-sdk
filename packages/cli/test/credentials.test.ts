import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configDir, readConfig, writeConfig } from '../src/auth/config'
import { keyPrefix, removeProfile, resolveCredentials, saveProfile, siteUrl } from '../src/auth/credentials'
import { memoryStore } from '../src/auth/keychain'
import { CliError, ExitCode } from '../src/errors'
import { fakeFetch, harness, json, KEY } from './harness'

const FLAG_KEY = 'inv_live_flag0001_x'
const ENV_KEY = 'inv_live_env00001_x'
const PROFILE_KEY = 'inv_live_prof0001_x'

function dir() {
  return mkdtempSync(join(tmpdir(), 'invoice-ai-cred-'))
}

async function withProfile(name = 'default', key = PROFILE_KEY) {
  const d = dir()
  const secrets = memoryStore()
  await saveProfile({ name, apiKey: key, meta: { email: 'me@x.test' }, configDir: d, secrets, now: new Date(0) })
  return { d, secrets }
}

describe('credential resolution order', () => {
  it('--api-key beats INVOICE_AI_API_KEY beats the profile', async () => {
    const { d, secrets } = await withProfile()
    const env = { INVOICE_AI_API_KEY: ENV_KEY }
    const r1 = await resolveCredentials({ flagKey: FLAG_KEY, env, configDir: d, secrets })
    expect([r1.apiKey, r1.source]).toEqual([FLAG_KEY, 'flag'])
    const r2 = await resolveCredentials({ env, configDir: d, secrets })
    expect([r2.apiKey, r2.source]).toEqual([ENV_KEY, 'env'])
    const r3 = await resolveCredentials({ env: {}, configDir: d, secrets })
    expect([r3.apiKey, r3.source, r3.profileName]).toEqual([PROFILE_KEY, 'profile', 'default'])
  })

  it('picks the profile from --profile, then INVOICE_AI_PROFILE, then the active one', async () => {
    const d = dir()
    const secrets = memoryStore()
    const base = { meta: {}, configDir: d, secrets, now: new Date(0) }
    await saveProfile({ ...base, name: 'work', apiKey: 'inv_live_work0001_x' })
    await saveProfile({ ...base, name: 'home', apiKey: 'inv_live_home0001_x' }) // now active
    expect((await resolveCredentials({ env: {}, configDir: d, secrets })).profileName).toBe('home')
    expect((await resolveCredentials({ env: { INVOICE_AI_PROFILE: 'work' }, configDir: d, secrets })).apiKey).toBe('inv_live_work0001_x')
    expect(
      (await resolveCredentials({ flagProfile: 'home', env: { INVOICE_AI_PROFILE: 'work' }, configDir: d, secrets })).apiKey,
    ).toBe('inv_live_home0001_x')
  })

  it('fails with exit 3 when nothing is configured', async () => {
    const err = await resolveCredentials({ env: {}, configDir: dir(), secrets: memoryStore() }).catch((e) => e)
    expect(err).toBeInstanceOf(CliError)
    expect(err.exitCode).toBe(ExitCode.AUTH)
    expect(err.message).toBe('Not logged in.')
  })

  it('fails with exit 2 for an unknown --profile when others exist', async () => {
    const { d, secrets } = await withProfile()
    const err = await resolveCredentials({ flagProfile: 'nope', env: {}, configDir: d, secrets }).catch((e) => e)
    expect(err.exitCode).toBe(ExitCode.USAGE)
    expect(err.hint).toContain('default')
  })

  it('rejects malformed keys with exit 3 before any request', async () => {
    const err = await resolveCredentials({ flagKey: 'sk_test_123', env: {}, configDir: dir(), secrets: memoryStore() }).catch((e) => e)
    expect(err.exitCode).toBe(ExitCode.AUTH)
    expect(err.message).toContain('--api-key')
  })

  it('uses the profile base URL unless INVOICE_AI_BASE_URL is set', async () => {
    const d = dir()
    const secrets = memoryStore()
    await saveProfile({ name: 'local', apiKey: KEY, meta: { base_url: 'http://localhost:3000/api/v1' }, configDir: d, secrets, now: new Date(0) })
    expect((await resolveCredentials({ env: {}, configDir: d, secrets })).baseURL).toBe('http://localhost:3000/api/v1')
    expect((await resolveCredentials({ env: { INVOICE_AI_BASE_URL: 'http://x/api/v1' }, configDir: d, secrets })).baseURL).toBe('http://x/api/v1')
  })
})

describe('profile storage', () => {
  it('keeps the secret in the keychain and only metadata in the file', async () => {
    const { d, secrets } = await withProfile()
    expect(secrets.data.get('default')).toBe(PROFILE_KEY)
    const raw = readFileSync(join(d, 'config.json'), 'utf8')
    expect(raw).not.toContain(PROFILE_KEY)
    const cfg = await readConfig(d)
    expect(cfg.profiles.default).toMatchObject({ storage: 'keychain', key_prefix: 'inv_live_prof0001…', email: 'me@x.test' })
  })

  it('falls back to the config file (mode 0600) when the keychain is unavailable', async () => {
    const d = dir()
    const secrets = memoryStore({}, false)
    await saveProfile({ name: 'default', apiKey: PROFILE_KEY, meta: {}, configDir: d, secrets, now: new Date(0) })
    const cfg = await readConfig(d)
    expect(cfg.profiles.default).toMatchObject({ storage: 'file', api_key: PROFILE_KEY })
    expect(statSync(join(d, 'config.json')).mode & 0o777).toBe(0o600)
    expect((await resolveCredentials({ env: {}, configDir: d, secrets })).apiKey).toBe(PROFILE_KEY)
  })

  it('reports a keychain entry that went missing (exit 3)', async () => {
    const { d, secrets } = await withProfile()
    secrets.data.clear()
    const err = await resolveCredentials({ env: {}, configDir: d, secrets }).catch((e) => e)
    expect(err.exitCode).toBe(ExitCode.AUTH)
    expect(err.message).toContain('missing')
  })

  it('removeProfile clears keychain and config and re-points the active profile', async () => {
    const d = dir()
    const secrets = memoryStore()
    const base = { meta: {}, configDir: d, secrets, now: new Date(0) }
    await saveProfile({ ...base, name: 'default', apiKey: KEY })
    await saveProfile({ ...base, name: 'work', apiKey: KEY })
    expect(await removeProfile('work', d, secrets)).toBe(true)
    const cfg = await readConfig(d)
    expect(Object.keys(cfg.profiles)).toEqual(['default'])
    expect(cfg.active_profile).toBe('default')
    expect(secrets.data.has('work')).toBe(false)
  })

  it('tolerates a corrupt config file', async () => {
    const d = dir()
    await writeConfig(d, { version: 1, profiles: {} })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(d, 'config.json'), '{nope')
    expect(await readConfig(d)).toEqual({ version: 1, profiles: {} })
  })
})

describe('helpers', () => {
  it('configDir honours INVOICE_AI_CONFIG_DIR and XDG_CONFIG_HOME', () => {
    expect(configDir({ INVOICE_AI_CONFIG_DIR: '/a' })).toBe('/a')
    expect(configDir({ XDG_CONFIG_HOME: '/x' })).toBe('/x/invoice-ai')
    expect(configDir({ HOME: '/home/me' })).toBe('/home/me/.config/invoice-ai')
  })

  it('siteUrl strips /api/v1 from INVOICE_AI_BASE_URL', () => {
    expect(siteUrl(undefined)).toBe('https://invoice.horizonpay.co')
    expect(siteUrl('http://localhost:3000/api/v1')).toBe('http://localhost:3000')
    expect(siteUrl('https://preview.example/api/v1/')).toBe('https://preview.example')
  })

  it('keyPrefix never reveals the secret part', () => {
    expect(keyPrefix(KEY)).toBe('inv_live_ab12cd34…')
  })
})

describe('switch / whoami through the CLI', () => {
  it('switch changes the active profile and lists profiles without a TTY', async () => {
    const h = harness()
    const base = { meta: { email: 'a@x.test' }, configDir: h.configDir, secrets: h.secrets, now: new Date(0) }
    await saveProfile({ ...base, name: 'default', apiKey: KEY })
    await saveProfile({ ...base, name: 'work', apiKey: KEY })
    expect(await h.run('switch', 'default')).toBe(0)
    expect((await readConfig(h.configDir)).active_profile).toBe('default')
    expect(await h.run('switch', 'missing')).toBe(2)
    const h2 = { ...h }
    h.stdout.text = ''
    expect(await h2.run('switch', '--json')).toBe(0)
    expect(JSON.parse(h.stdout.text).map((p: { profile: string; active: boolean }) => [p.profile, p.active])).toEqual([
      ['default', true],
      ['work', false],
    ])
  })

  it('whoami calls business.retrieve and shows key prefix, source and scopes', async () => {
    const f = fakeFetch(({ url, headers }) => {
      expect(url.pathname).toBe('/api/v1/business')
      expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
      return json({ data: { id: 'biz_1', legal_name: 'QA Studio LLP', trade_name: 'QA Studio', email: 'owner@qa.test', currency: 'USD' } })
    })
    const h = harness({ fetch: f })
    await saveProfile({ name: 'default', apiKey: KEY, meta: { email: 'me@qa.test', scopes: ['invoices:read'] }, configDir: h.configDir, secrets: h.secrets, now: new Date(0) })
    expect(await h.run('whoami', '--json')).toBe(0)
    const out = JSON.parse(h.stdout.text)
    expect(out).toMatchObject({
      business: 'QA Studio',
      email: 'me@qa.test',
      profile: 'default',
      key: 'inv_live_ab12cd34…',
      key_source: 'profile (keychain)',
      scopes: ['invoices:read'],
    })
    expect(h.stdout.text).not.toContain('secretpart')
  })
})
