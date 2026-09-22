import { hostname } from 'node:os'
import type { SecretStore } from './auth/keychain'

/** A writable stream, reduced to what the CLI uses. */
export interface OutStream {
  write(chunk: string | Uint8Array): unknown
  isTTY?: boolean
  columns?: number
}

/**
 * Everything the CLI touches in the outside world. `run()` takes these as an
 * argument so tests can drive the whole program in-process with fakes.
 */
export interface Deps {
  env: Record<string, string | undefined>
  stdout: OutStream
  stderr: OutStream
  stdinIsTTY: boolean
  readStdin(): Promise<string>
  /** Used for the device-flow endpoints, webhook tests and handed to the SDK. */
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): number
  openUrl(target: string): Promise<void>
  /** OS keychain; the default loads @napi-rs/keyring lazily. */
  secretStore?: SecretStore
  hostname(): string
  platform: string
  arch: string
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks).toString('utf8')
    },
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    openUrl: async (target) => {
      const { default: open } = await import('open')
      await open(target, { wait: false })
    },
    hostname: () => hostname(),
    platform: process.platform,
    arch: process.arch,
  }
}
