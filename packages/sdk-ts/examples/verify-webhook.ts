/**
 * A webhook receiver that verifies Invoice-AI's signature before trusting the event.
 *
 *   INVOICE_AI_WEBHOOK_SECRET=whsec_… npx tsx examples/verify-webhook.ts
 *
 * With no secret set it signs and delivers a sample event to itself, so you
 * can run it offline and watch the round trip.
 */
import { createServer } from 'node:http'
import { Webhooks, WebhookVerificationError } from '@horizonpay/invoice-ai'

const secret = process.env.INVOICE_AI_WEBHOOK_SECRET ?? `whsec_${btoa('example-secret-for-local-testing!')}`
const webhooks = new Webhooks(secret) // no API key needed just to verify

const server = createServer(async (req, res) => {
  // Read the RAW body: a parsed-and-reserialised body won't match the signature.
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const rawBody = Buffer.concat(chunks)

  try {
    const event = await webhooks.constructEvent(rawBody, req.headers)
    switch (event.type) {
      case 'invoice.paid':
        console.log(`✔ ${event.data.object.number} was paid`)
        break
      default:
        console.log(`✔ ${event.type} (${event.id})`)
    }
    res.writeHead(204).end() // any 2xx acknowledges the delivery
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      console.warn(`✘ rejected: ${err.message}`)
      res.writeHead(400).end('invalid signature')
    } else {
      res.writeHead(500).end()
    }
  }
})

server.listen(0, async () => {
  const { port } = server.address() as { port: number }
  console.log(`Listening on http://localhost:${port}/`)
  if (process.env.INVOICE_AI_WEBHOOK_SECRET) return

  // Demo: deliver one signed event and one forged one.
  const body = JSON.stringify({
    id: 'evt_demo',
    type: 'invoice.paid',
    created_at: new Date().toISOString(),
    data: { object: { id: 'in_demo', object: 'invoice', number: 'INV-0042', status: 'paid' } },
  })
  const headers = await webhooks.sign(body)
  const url = `http://localhost:${port}/`
  await fetch(url, { method: 'POST', headers, body })
  await fetch(url, { method: 'POST', headers, body: body.replace('INV-0042', 'INV-9999') })
  server.close()
})
