/**
 * @horizonpay/invoice-ai — the official TypeScript SDK for the Invoice-AI API.
 *
 *   import InvoiceAI from '@horizonpay/invoice-ai'
 *   const invoiceai = new InvoiceAI()               // reads INVOICE_AI_API_KEY
 *   const inv = await invoiceai.invoices.create({ customer: 'cus_…', items: [{ price: 'price_…', quantity: 1 }] })
 */
import type { ClientOptions } from './core/client'
import { Webhooks } from './core/webhooks'
import { InvoiceAIResources } from './resources'

export class InvoiceAI extends InvoiceAIResources {
  /** Webhook signature verification: `await invoiceai.webhooks.constructEvent(body, headers, secret)`. */
  readonly webhooks: Webhooks

  constructor(options: ClientOptions & { webhookSecret?: string } = {}) {
    const { webhookSecret, ...rest } = options
    super(rest)
    this.webhooks = new Webhooks(webhookSecret)
  }
}

export default InvoiceAI

export { APIPromise } from './core/api-promise'
export { BaseClient, DEFAULT_BASE_URL, type ClientOptions, type RawRequestOptions } from './core/client'
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  ConflictError,
  ERROR_CLASS_BY_CODE,
  IdempotencyError,
  IdempotencyKeyRequiredError,
  InternalServerError,
  InvalidStateError,
  InvoiceAIError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UpstreamError,
  ValidationError,
  WebhookVerificationError,
  type FieldError,
  type ProblemBody,
} from './core/errors'
export type { HttpMethod, RateLimitInfo, RequestOptions, ResponseMeta } from './core/http'
export type { LogLevel, Logger } from './core/logger'
export { currencyDecimals, formatMoney, fromMinor, toMinor, type FormatMoneyOptions } from './core/money'
export { Page, PagePromise, type ToArrayOptions } from './core/pagination'
export { API_VERSION, VERSION } from './core/version'
export {
  constructEvent,
  signPayload,
  verifySignature,
  Webhooks,
  type AnyWebhookEvent,
  type InvoiceCreatedEvent,
  type InvoiceDownloadedEvent,
  type InvoiceEmailedEvent,
  type InvoiceEmailFailedEvent,
  type InvoiceFinalizedEvent,
  type InvoicePaidEvent,
  type InvoiceUpdatedEvent,
  type InvoiceViewedEvent,
  type InvoiceVoidedEvent,
  type SignOptions,
  type VerifyOptions,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookHeaders,
  type WebhookPayload,
} from './core/webhooks'
export type * from './generated/types'
export { OPERATIONS, type OperationId } from './generated/operations'
export * from './resources'
