import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/auth/config'
import { DeviceFlowError, pollForToken, requestDeviceCode, revokeSession, type PollEvent } from '../src/auth/device-flow'
import { saveProfile } from '../src/auth/credentials'
import { ExitCode } from '../src/errors'
import { fakeFetch, harness, json, KEY, problem } from './harness'

const SITE = 'https://api.test'
const DEVICE = {
  device_code: 'dc_secret_device_code',
  user_code: 'WXYZ-2345',
  verification_uri: `${SITE}/cli/authorize`,
  verification_uri_complete: `${SITE}/cli/authorize?code=WXYZ-2345`,
  interval: 5,
  expires_in: 600,
}
const TOKEN = {
  api_key: KEY,
  key_id: 'key_1',
  scopes: ['invoices:read', 'invoices:write'],
  account: { email: 'me@qa.test', business_name: 'QA Studio' },
}
const err = (error: string, status = 400, headers: Record<string, string> = {}) =>
  json({ error, error_description: `${error} description` }, status, headers)

/** A fake token endpoint that answers from a script, one response per poll. */
function scripted(responses: (() => Response)[]) {
  let i = 0
  return fakeFetch(({ url }) => {
    if (url.pathname === '/api/cli/device') return json(DEVICE)
    if (url.pathname === '/api/cli/token') {
      const next = responses[Math.min(i++, responses.length - 1)]!
      return next()
    }
    return json({}, 404)
  })
}

function clockDeps(fetchImpl: typeof fetch) {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    deps: {
      fetch: fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
      now: () => now,
    },
  }
}

const poll = (fetchImpl: typeof fetch, events: PollEvent[] = [], expiresIn = 600) => {
  const c = clockDeps(fetchImpl)
  return {
    ...c,
    run: () =>
      pollForToken(c.deps, { site: SITE, deviceCode: DEVICE.device_code, interval: 5, expiresIn, onPoll: (e) => events.push(e) }),
  }
}

describe('pollForToken state machine', () => {
  it('pending → slow_down → success, adding 5s to the interval on slow_down', async () => {
    const f = scripted([() => err('authorization_pending'), () => err('slow_down'), () => err('authorization_pending'), () => json(TOKEN)])
    const events: PollEvent[] = []
    const p = poll(f, events)
    const token = await p.run()
    expect(token).toEqual(TOKEN)
    expect(p.sleeps).toEqual([5000, 5000, 10000, 10000])
    expect(events.map((e) => [e.outcome, e.interval])).toEqual([
      ['authorization_pending', 5],
      ['slow_down', 10],
      ['authorization_pending', 10],
    ])
    const polls = f.calls.filter((c) => c.url.pathname === '/api/cli/token')
    expect(polls).toHaveLength(4)
    expect(JSON.parse(polls[0]!.body)).toEqual({ device_code: DEVICE.device_code })
  })

  it('access_denied ends with exit 3', async () => {
    const e = await poll(scripted([() => err('authorization_pending'), () => err('access_denied')])).run().catch((x) => x)
    expect(e).toBeInstanceOf(DeviceFlowError)
    expect([e.code, e.exitCode]).toEqual(['access_denied', ExitCode.AUTH])
  })

  it('expired_token from the server ends with exit 3', async () => {
    const e = await poll(scripted([() => err('expired_token')])).run().catch((x) => x)
    expect([e.code, e.exitCode]).toEqual(['expired_token', ExitCode.AUTH])
  })

  it('stops by itself when the code outlives expires_in', async () => {
    const f = scripted([() => err('authorization_pending')])
    const p = poll(f, [], 12)
    const e = await p.run().catch((x) => x)
    expect(e.code).toBe('expired_token')
    // Polls at t=5s and t=10s; the wake-up at 15s is past the 12s deadline.
    expect(f.calls.filter((c) => c.url.pathname === '/api/cli/token')).toHaveLength(2)
  })

  it('invalid_grant ends with exit 3', async () => {
    const e = await poll(scripted([() => err('invalid_grant')])).run().catch((x) => x)
    expect([e.code, e.exitCode]).toEqual(['invalid_grant', ExitCode.AUTH])
  })

  it('retries transient 5xx / 429 / network errors, then succeeds', async () => {
    let n = 0
    const f = fakeFetch(() => {
      n++
      if (n === 1) return err('server_error', 500)
      if (n === 2) return err('rate_limited', 429, { 'retry-after': '20' })
      if (n === 3) throw new TypeError('fetch failed')
      return json(TOKEN)
    })
    const events: PollEvent[] = []
    const p = poll(f, events)
    expect(await p.run()).toEqual(TOKEN)
    expect(events.map((e) => e.outcome)).toEqual(['retry', 'retry', 'retry'])
    // 429 with Retry-After: 20 waits the extra 15s on top of the 5s interval.
    expect(p.sleeps).toEqual([5000, 5000, 15000, 5000, 5000])
  })

  it('gives up after repeated server errors (exit 1)', async () => {
    const e = await poll(scripted([() => err('server_error', 500)])).run().catch((x) => x)
    expect([e.code, e.exitCode]).toEqual(['server_error', ExitCode.API])
  })
})

describe('requestDeviceCode', () => {
  it('sends client name and OS and returns the codes', async () => {
    const f = scripted([])
    const { deps } = clockDeps(f)
    const d = await requestDeviceCode(deps, SITE, { name: 'my-mbp', os: 'darwin arm64' })
    expect(d).toEqual(DEVICE)
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ client_name: 'my-mbp', client_os: 'darwin arm64' })
  })

  it('maps 429 to exit 4 with the Retry-After in the hint', async () => {
    const f = fakeFetch(() => err('rate_limited', 429, { 'retry-after': '42' }))
    const e = await requestDeviceCode(clockDeps(f).deps, SITE, { name: 'x', os: 'y' }).catch((x) => x)
    expect([e.code, e.exitCode]).toEqual(['rate_limited', ExitCode.RATE_LIMITED])
    expect(e.hint).toContain('42s')
  })

  it('maps 500 to exit 1 with the server description', async () => {
    const f = fakeFetch(() => err('server_error', 500))
    const e = await requestDeviceCode(clockDeps(f).deps, SITE, { name: 'x', os: 'y' }).catch((x) => x)
    expect(e.exitCode).toBe(ExitCode.API)
    expect(e.message).toBe('server_error description')
  })
})

describe('revokeSession', () => {
  it('treats 204 as revoked and 401 as already revoked', async () => {
    const ok = fakeFetch(() => new Response(null, { status: 204 }))
    expect(await revokeSession({ fetch: ok }, SITE, KEY)).toBe('revoked')
    expect(ok.calls[0]!.method).toBe('DELETE')
    expect(ok.calls[0]!.url.href).toBe(`${SITE}/api/cli/session`)
    expect(ok.calls[0]!.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const gone = fakeFetch(() => problem(401, 'unauthorized', 'revoked'))
    expect(await revokeSession({ fetch: gone }, SITE, KEY)).toBe('already_revoked')
  })
})

describe('invoice-ai login / logout', () => {
  it('prints the code, opens the browser in a TTY, polls and stores the key', async () => {
    const f = scripted([() => err('authorization_pending'), () => json(TOKEN)])
    const h = harness({ fetch: f, tty: true })
    expect(await h.run('login')).toBe(0)
    expect(h.stderr.text).toContain('WXYZ-2345')
    expect(h.opened).toEqual([DEVICE.verification_uri_complete])
    expect(h.stderr.text).toContain('Logged in as me@qa.test (QA Studio)')
    expect(h.secrets.data.get('default')).toBe(KEY)
    const cfg = await readConfig(h.configDir)
    expect(cfg.active_profile).toBe('default')
    expect(cfg.profiles.default).toMatchObject({ storage: 'keychain', key_id: 'key_1', scopes: TOKEN.scopes, email: 'me@qa.test' })
    // Device endpoints are derived from INVOICE_AI_BASE_URL minus /api/v1.
    expect(f.calls[0]!.url.href).toBe(`${SITE}/api/cli/device`)
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ client_name: 'test-host', client_os: 'linux x64' })
  })

  it('--no-browser only prints the URL', async () => {
    const h = harness({ fetch: scripted([() => json(TOKEN)]), tty: true })
    expect(await h.run('login', '--no-browser', '--profile', 'work')).toBe(0)
    expect(h.opened).toEqual([])
    expect(h.stderr.text).toContain(`Visit ${DEVICE.verification_uri_complete}`)
    expect(h.secrets.data.get('work')).toBe(KEY)
  })

  it('denied in the browser → exit 3 and nothing stored', async () => {
    const h = harness({ fetch: scripted([() => err('access_denied')]) })
    expect(await h.run('login')).toBe(ExitCode.AUTH)
    expect(h.stderr.text).toContain('Login was denied')
    expect(h.secrets.data.size).toBe(0)
  })

  it('login --api-key verifies the key with the SDK and stores it without a browser', async () => {
    const f = fakeFetch(({ url }) => {
      expect(url.href).toBe('https://api.test/api/v1/business')
      return json({ data: { id: 'biz_1', legal_name: 'QA Studio LLP', trade_name: null, email: 'owner@qa.test' } })
    })
    const h = harness({ fetch: f })
    expect(await h.run('login', '--api-key', KEY)).toBe(0)
    expect(h.secrets.data.get('default')).toBe(KEY)
    expect((await readConfig(h.configDir)).profiles.default?.business_name).toBe('QA Studio LLP')
  })

  it('logout revokes server-side and forgets the profile; 401 counts as success', async () => {
    const f = fakeFetch(({ url, method }) => {
      expect([method, url.pathname]).toEqual(['DELETE', '/api/cli/session'])
      return problem(401, 'unauthorized', 'already revoked')
    })
    const h = harness({ fetch: f })
    await saveProfile({ name: 'default', apiKey: KEY, meta: {}, configDir: h.configDir, secrets: h.secrets, now: new Date(0) })
    expect(await h.run('logout')).toBe(0)
    expect(h.secrets.data.size).toBe(0)
    expect((await readConfig(h.configDir)).profiles).toEqual({})
    expect(h.stderr.text).toContain('Logged out')
    expect(h.stderr.text).not.toContain('Could not revoke')
  })

  it('logout when not logged in is a no-op (exit 0)', async () => {
    const h = harness()
    expect(await h.run('logout')).toBe(0)
    expect(h.stderr.text).toContain('Not logged in')
  })
})
