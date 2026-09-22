import { KEYCHAIN_SERVICE } from '../constants'

/**
 * Secrets in the OS credential store: macOS Keychain, Windows Credential
 * Manager, or the Secret Service (GNOME Keyring / KWallet) on Linux.
 *
 * Every method degrades instead of throwing: headless Linux boxes, containers
 * and CI runners often have no store at all, and the caller then falls back
 * to the 0600 config file.
 */
export interface SecretStore {
  /** Human name for messages, e.g. "the macOS Keychain". */
  readonly label: string
  get(account: string): Promise<string | undefined>
  /** True when the secret was stored (and read back). */
  set(account: string, secret: string): Promise<boolean>
  delete(account: string): Promise<void>
}

type KeyringModule = typeof import('@napi-rs/keyring')

export function osKeychain(env: Record<string, string | undefined>, platform: string): SecretStore {
  const disabled = Boolean(env.INVOICE_AI_NO_KEYCHAIN)
  let mod: Promise<KeyringModule | null> | undefined
  const load = () => {
    if (disabled) return Promise.resolve(null)
    mod ??= import('@napi-rs/keyring').catch(() => null)
    return mod
  }
  const entry = async (account: string) => {
    const m = await load()
    return m ? new m.AsyncEntry(KEYCHAIN_SERVICE, account) : null
  }

  return {
    label: platform === 'darwin' ? 'the macOS Keychain' : platform === 'win32' ? 'Windows Credential Manager' : 'the system keyring',
    async get(account) {
      try {
        return (await (await entry(account))?.getPassword()) ?? undefined
      } catch {
        return undefined
      }
    },
    async set(account, secret) {
      try {
        const e = await entry(account)
        if (!e) return false
        await e.setPassword(secret)
        // Some stores accept a write and then can't read it back (a locked
        // keyring with no agent); only trust the keychain if the read works.
        return (await e.getPassword()) === secret
      } catch {
        return false
      }
    },
    async delete(account) {
      try {
        await (await entry(account))?.deleteCredential()
      } catch {
        // Nothing stored, or the store is unavailable: either way it's gone.
      }
    },
  }
}

/** An in-memory store, for tests. */
export function memoryStore(initial: Record<string, string> = {}, available = true): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    label: 'the test keychain',
    data,
    async get(account) {
      return available ? data.get(account) : undefined
    },
    async set(account, secret) {
      if (!available) return false
      data.set(account, secret)
      return true
    },
    async delete(account) {
      data.delete(account)
    },
  }
}
