import { DEFAULT_PROFILE, DEFAULT_SITE_URL } from '../constants'
import { authError, usageError } from '../errors'
import { readConfig, writeConfig, type ConfigFile, type Profile } from './config'
import type { SecretStore } from './keychain'

/**
 * Where the API key comes from, highest priority first:
 *
 *   1. --api-key                 (one-off)
 *   2. INVOICE_AI_API_KEY        (CI)
 *   3. the active profile        (`invoice-ai login`; secret in the keychain)
 *
 * The profile is --profile, else INVOICE_AI_PROFILE, else the one chosen with
 * `invoice-ai switch`, else "default".
 */

export type CredentialSource = 'flag' | 'env' | 'profile'

export interface ResolvedCredentials {
  apiKey: string
  source: CredentialSource
  /** The profile consulted (always set for `profile`, informational otherwise). */
  profileName: string
  profile?: Profile
  /** API base URL: INVOICE_AI_BASE_URL, else the profile's, else production. */
  baseURL?: string
}

export interface ResolveInput {
  flagKey?: string
  flagProfile?: string
  env: Record<string, string | undefined>
  configDir: string
  secrets: SecretStore
}

const KEY_SHAPE = /^inv_[a-z]+_\S+$/

export function assertKeyShape(key: string, where: string): void {
  if (!KEY_SHAPE.test(key)) {
    throw authError(`The API key from ${where} doesn't look like an Invoice-AI key (they start with \`inv_live_\`).`)
  }
}

/** `inv_live_ab12cd34_…` → `inv_live_ab12cd34…` (the SDK redacts the same way). */
export function keyPrefix(key: string): string {
  const m = key.match(/^(inv_[a-z]+_[A-Za-z0-9]{1,8})/)
  return m ? `${m[1]}…` : `${key.slice(0, 4)}…`
}

export function profileNameFor(flagProfile: string | undefined, env: Record<string, string | undefined>, config: ConfigFile): string {
  return flagProfile || env.INVOICE_AI_PROFILE || config.active_profile || DEFAULT_PROFILE
}

export async function resolveCredentials(input: ResolveInput): Promise<ResolvedCredentials> {
  const { env } = input
  const config = await readConfig(input.configDir)
  const profileName = profileNameFor(input.flagProfile, env, config)
  const envBase = env.INVOICE_AI_BASE_URL || undefined

  if (input.flagKey) {
    assertKeyShape(input.flagKey, '--api-key')
    return { apiKey: input.flagKey, source: 'flag', profileName, baseURL: envBase }
  }
  if (env.INVOICE_AI_API_KEY) {
    assertKeyShape(env.INVOICE_AI_API_KEY, 'INVOICE_AI_API_KEY')
    return { apiKey: env.INVOICE_AI_API_KEY, source: 'env', profileName, baseURL: envBase }
  }

  const profile = config.profiles[profileName]
  if (!profile) {
    if (input.flagProfile && Object.keys(config.profiles).length > 0) {
      throw usageError(
        `No profile named "${profileName}".`,
        `Profiles: ${Object.keys(config.profiles).join(', ')}. Create one with \`invoice-ai login --profile ${profileName}\`.`,
      )
    }
    throw authError(
      'Not logged in.',
      'Run `invoice-ai login`, or set INVOICE_AI_API_KEY (for CI), or pass --api-key.',
    )
  }
  const apiKey = await readProfileSecret(profileName, profile, input.secrets)
  if (!apiKey) {
    throw authError(
      `The key for profile "${profileName}" is missing from ${input.secrets.label}.`,
      `Run \`invoice-ai login${profileName === DEFAULT_PROFILE ? '' : ` --profile ${profileName}`}\` again.`,
    )
  }
  return { apiKey, source: 'profile', profileName, profile, baseURL: envBase ?? profile.base_url }
}

export async function readProfileSecret(name: string, profile: Profile, secrets: SecretStore): Promise<string | undefined> {
  if (profile.storage === 'file') return profile.api_key
  return (await secrets.get(name)) ?? profile.api_key
}

export interface SaveProfileInput {
  name: string
  apiKey: string
  meta: Omit<Profile, 'storage' | 'api_key' | 'key_prefix' | 'created_at'>
  configDir: string
  secrets: SecretStore
  now: Date
}

/** Stores the key (keychain first, 0600 file second) and makes the profile active. */
export async function saveProfile(input: SaveProfileInput): Promise<Profile> {
  const inKeychain = await input.secrets.set(input.name, input.apiKey)
  const profile: Profile = {
    storage: inKeychain ? 'keychain' : 'file',
    ...(inKeychain ? {} : { api_key: input.apiKey }),
    key_prefix: keyPrefix(input.apiKey),
    ...stripUndefined(input.meta),
    created_at: input.now.toISOString(),
  }
  const config = await readConfig(input.configDir)
  config.profiles[input.name] = profile
  config.active_profile = input.name
  await writeConfig(input.configDir, config)
  return profile
}

/** Forgets a profile locally (keychain entry and config). Returns whether it existed. */
export async function removeProfile(name: string, configDir: string, secrets: SecretStore): Promise<boolean> {
  const config = await readConfig(configDir)
  const existed = name in config.profiles
  await secrets.delete(name)
  if (existed) {
    delete config.profiles[name]
    if (config.active_profile === name) {
      const remaining = Object.keys(config.profiles)
      config.active_profile = remaining.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : remaining[0]
    }
    await writeConfig(configDir, config)
  }
  return existed
}

/** Site root for the device flow and `open`: INVOICE_AI_BASE_URL minus /api/v1. */
export function siteUrl(apiBaseURL: string | undefined): string {
  if (!apiBaseURL) return DEFAULT_SITE_URL
  return apiBaseURL.replace(/\/+$/, '').replace(/\/api\/v1$/, '') || DEFAULT_SITE_URL
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
