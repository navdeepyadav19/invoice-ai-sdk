/** Keep in sync with package.json; a test checks. */
export const CLI_VERSION = '0.1.0'

export const PACKAGE_NAME = '@horizonpay/invoice-ai-cli'

/** The web app. Device login, `open` and `logout` talk to it directly. */
export const DEFAULT_SITE_URL = 'https://invoice.horizonpay.co'

/** Where `invoice-ai docs` points. */
export const DOCS_BASE_URL = 'https://docs.horizonpay.co'

/** `invoice-ai docs <topic>` → page path under DOCS_BASE_URL. */
export const DOCS_TOPICS: Readonly<Record<string, string>> = {
  home: '/introduction',
  quickstart: '/quickstart',
  auth: '/authentication',
  errors: '/errors',
  idempotency: '/idempotency',
  pagination: '/pagination',
  'rate-limits': '/rate-limits',
  ids: '/ids-and-objects',
  lifecycle: '/invoice-lifecycle',
  webhooks: '/webhooks',
  api: '/api-reference/introduction',
  cli: '/cli/commands',
  changelog: '/changelog',
}

/** OS keychain service name; the account is the profile name. */
export const KEYCHAIN_SERVICE = 'invoice-ai-cli'

export const DEFAULT_PROFILE = 'default'

/** Every event type the API emits (mirrors the WebhookEndpointCreate enum). */
export const WEBHOOK_EVENT_TYPES = [
  'invoice.created',
  'invoice.updated',
  'invoice.finalized',
  'invoice.emailed',
  'invoice.email_failed',
  'invoice.viewed',
  'invoice.downloaded',
  'invoice.paid',
  'invoice.voided',
] as const
