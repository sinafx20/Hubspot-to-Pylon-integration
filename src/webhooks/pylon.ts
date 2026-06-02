import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'
import { config } from '../config'
import { integrationQueue } from '../queue/index'
import { isEventProcessed, logEvent } from '../db/events'

// Pylon sends JSON:API format for all webhook events
interface PylonWebhookPayload {
  data?: {
    id?: string
    type?: string
    attributes?: {
      name?: string          // the event type e.g. "proposals.shared"
      created_at?: string
      description?: string
      [key: string]: unknown
    }
    relationships?: {
      solar_project?: {
        data?: { type?: string; id?: string }
      }
      [key: string]: unknown
    }
  }
}

function verifyPylonSignature(req: FastifyRequest): boolean {
  // TODO: Pylon's exact HMAC format is undocumented — confirm with support and re-enable.
  // The header is "pylon-webhook-signature: hs256=<hex>" but the message format is unclear
  // (may include timestamp). For now we check the header exists as a basic sanity check.
  const header = req.headers['pylon-webhook-signature'] as string | undefined
  if (config.PYLON_WEBHOOK_SECRET && !header) {
    console.warn('[pylon-webhook] Missing pylon-webhook-signature header')
    return false
  }
  return true
}

function extractProjectId(payload: PylonWebhookPayload): string | null {
  return payload.data?.relationships?.solar_project?.data?.id ?? null
}

export async function pylonWebhookRoute(fastify: FastifyInstance) {
  fastify.post('/pylon', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifyPylonSignature(req)) {
      return reply.code(401).send({ error: 'Invalid signature' })
    }

    reply.code(200).send({ received: true })

    const payload = req.body as PylonWebhookPayload

    const eventType = payload.data?.attributes?.name
    const eventId = `pylon-${payload.data?.id ?? Date.now()}`

    if (!eventType) {
      console.warn('[pylon-webhook] No event type found in payload:', JSON.stringify(payload))
      return
    }

    console.log(`[pylon-webhook] event="${eventType}" id="${eventId}"`)


    const alreadyDone = await isEventProcessed(eventId)
    if (alreadyDone) return

    const pylonProjectId = extractProjectId(payload)

    // Both "Send proposal" and "Send e-Signature request" mean the quote has been sent
    if (eventType === 'proposals.shared' || eventType === 'esignature_requests.sent') {
      await logEvent({
        eventId,
        direction: 'pylon_to_hs',
        eventType,
        pylonProjectId: pylonProjectId ?? undefined,
        status: 'queued',
      })

      await integrationQueue.add(
        'update-deal-quote-sent',
        { pylonProjectId, eventId },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: false,
        }
      )
    }

    if (eventType === 'web_proposals.signed') {
      await logEvent({
        eventId,
        direction: 'pylon_to_hs',
        eventType: 'web_proposals.signed',
        pylonProjectId: pylonProjectId ?? undefined,
        status: 'queued',
      })

      await integrationQueue.add(
        'update-deal-closed-won',
        { pylonProjectId, eventId },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: false,
        }
      )
    }
  })
}
