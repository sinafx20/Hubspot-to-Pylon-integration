import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'
import { config } from '../config'
import { integrationQueue } from '../queue/index'
import { isEventProcessed, logEvent } from '../db/events'

// HubSpot sends an array of events per request
interface HubSpotWebhookEvent {
  eventId: number
  subscriptionId: number
  portalId: number
  occurredAt: number
  subscriptionType: string  // HubSpot uses subscriptionType, not eventType
  objectId: number
  propertyName?: string
  propertyValue?: string
}

function verifyHubSpotSignature(req: FastifyRequest): boolean {
  const signature = req.headers['x-hubspot-signature-v3'] as string | undefined
  const timestamp = req.headers['x-hubspot-request-timestamp'] as string | undefined

  if (!signature || !timestamp) return false

  // Reject requests older than 5 minutes to prevent replay attacks
  if (Date.now() - parseInt(timestamp) > 300_000) return false

  const rawBody = JSON.stringify(req.body)
  const method = req.method.toUpperCase()
  const uri = `https://${req.hostname}${req.url}`
  const payload = `${method}${uri}${rawBody}${timestamp}`

  const expected = crypto
    .createHmac('sha256', config.HUBSPOT_CLIENT_SECRET)
    .update(payload)
    .digest('base64')

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

export async function hubspotWebhookRoute(fastify: FastifyInstance) {
  fastify.post('/hubspot', async (req: FastifyRequest, reply: FastifyReply) => {
    // Always respond 200 immediately so HubSpot doesn't retry unnecessarily
    if (!verifyHubSpotSignature(req)) {
      return reply.code(401).send({ error: 'Invalid signature' })
    }

    reply.code(200).send({ received: true })

    const events = req.body as HubSpotWebhookEvent[]

    for (const event of events) {
      if (event.subscriptionType !== 'deal.propertyChange') continue

      // Two triggers create Pylon projects:
      //  - deal moved to "Ready to Quote"        → initial sync of every associated account
      //  - the pylon_sync_requested flag set true → (re)sync accounts added after the deal moved on
      const isReadyToQuote =
        event.propertyName === 'dealstage' && event.propertyValue === config.HUBSPOT_STAGE_READY_TO_QUOTE
      const isSyncRequested =
        event.propertyName === config.HUBSPOT_SYNC_REQUESTED_PROP && event.propertyValue === 'true'
      if (!isReadyToQuote && !isSyncRequested) continue

      const eventId = `hs-${event.eventId}`
      const dealId = String(event.objectId)

      const alreadyDone = await isEventProcessed(eventId)
      if (alreadyDone) continue

      await logEvent({
        eventId,
        direction: 'hs_to_pylon',
        eventType: isSyncRequested ? 'deal.sync_requested' : 'deal.ready_to_quote',
        hubspotDealId: dealId,
        status: 'queued',
      })

      await integrationQueue.add(
        'create-pylon-project',
        { dealId, eventId, clearSyncFlag: isSyncRequested },
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
