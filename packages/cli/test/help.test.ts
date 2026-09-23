import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLI_VERSION } from '../src/constants'
import { harness } from './harness'

/**
 * `--help` snapshots: the command surface is an API too. A renamed flag or a
 * dropped command shows up here as a diff to review, not as a surprise.
 * Update intentionally with `vitest run -u`.
 */

const GROUPS = [
  [],
  ['login'],
  ['logout'],
  ['whoami'],
  ['switch'],
  ['customers'],
  ['customers', 'list'],
  ['customers', 'create'],
  ['products'],
  ['products', 'create'],
  ['prices'],
  ['prices', 'create'],
  ['prices', 'update'],
  ['invoices'],
  ['invoices', 'list'],
  ['invoices', 'create'],
  ['invoices', 'send'],
  ['invoices', 'void'],
  ['invoices', 'pdf'],
  ['invoice-items'],
  ['invoice-items', 'list'],
  ['invoice-items', 'create'],
  ['invoice-items', 'delete'],
  ['webhooks'],
  ['webhooks', 'test'],
  ['api'],
  ['open'],
  ['docs'],
  ['completion'],
]

describe('--help', () => {
  for (const group of GROUPS) {
    it(`invoice-ai ${[...group, '--help'].join(' ')}`, async () => {
      const h = harness()
      const code = await h.run(...group, '--help')
      expect(code).toBe(0)
      expect(h.stderr.text).toBe('')
      expect(h.stdout.text).toMatchSnapshot()
    })
  }

  it('prints help (exit 0) with no arguments', async () => {
    const h = harness()
    expect(await h.run()).toBe(0)
    expect(h.stdout.text).toContain('Usage: invoice-ai')
  })

  it('--version matches package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(CLI_VERSION).toBe(pkg.version)
    const h = harness()
    expect(await h.run('--version')).toBe(0)
    expect(h.stdout.text.trim()).toBe(pkg.version)
  })
})
