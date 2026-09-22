import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ~/.config/invoice-ai/config.json — profile metadata, and the API key itself
 * only when the OS keychain is unavailable. Always written with mode 0600
 * inside a 0700 directory.
 */

export interface Profile {
  /** Where the secret lives. `file` means `api_key` below holds it. */
  storage: 'keychain' | 'file'
  /** Only when storage is `file`. */
  api_key?: string
  /** `inv_live_ab12cd34…`: enough to recognise the key in Settings, useless to an attacker. */
  key_prefix: string
  key_id?: string | null
  scopes?: string[]
  email?: string | null
  business_name?: string | null
  /** Set when the profile was created against a non-default API (local dev, previews). */
  base_url?: string
  created_at: string
}

export interface ConfigFile {
  version: 1
  active_profile?: string
  profiles: Record<string, Profile>
}

export function configDir(env: Record<string, string | undefined>): string {
  if (env.INVOICE_AI_CONFIG_DIR) return env.INVOICE_AI_CONFIG_DIR
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'invoice-ai')
}

export function configPath(dir: string): string {
  return join(dir, 'config.json')
}

export async function readConfig(dir: string): Promise<ConfigFile> {
  let text: string
  try {
    text = await readFile(configPath(dir), 'utf8')
  } catch {
    return { version: 1, profiles: {} }
  }
  try {
    const parsed = JSON.parse(text) as Partial<ConfigFile>
    return {
      version: 1,
      active_profile: typeof parsed.active_profile === 'string' ? parsed.active_profile : undefined,
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    }
  } catch {
    // A corrupt file shouldn't brick the CLI; the next login rewrites it.
    return { version: 1, profiles: {} }
  }
}

export async function writeConfig(dir: string, config: ConfigFile): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = configPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  // Write-then-rename so a crash never leaves half a file, and create the
  // temp file 0600 so the key is never readable by others, even briefly.
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, target)
  await chmod(target, 0o600).catch(() => undefined)
}
