import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'
import { config } from '../config'
import { integrationQueue } from '../queue/index'
import { isEventProcessed, logEvent } from '../db/events'

interface PylonWebhookPayload {
  id?: string
  event_type?: string
  // Pylon wraps the changed resource under a key matching the event type.
  // e.g. proposals.shared → payload.proposal, web_proposals.signed → payload.web_proposal
  // Verify exact shape against Pylon's event documentation.
  [key: string]: unknown
}

function verifyPylonSignature(req: FastifyRequest): boolean {
  // Pylon signature verification — check their docs for the exact header name and algorithm.
  // If they use a shared secret in a header (common pattern):
  if (!config.PYLON_WEBHOOK_SECRET) return true // skip if no secret configured yet

  const signature = req.headers['x-pylon-signature'] as string | undefined
  if (!signature) return false

  const rawBody = JSON.stringify(req.body)
  const expected = crypto
    .createHmac('sha256', config.PYLON_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

function extractProjectId(payload: PylonWebhookPayload): string | null {
  // Pylon embeds the project ID inside the event payload.
  // Verify the exact field path from their webhook documentation.
  // Common patterns:
  const proposal = payload.proposal as Record<string, unknown> | undefined
  const webProposal = payload.web_proposal as Record<string, unknown> | undefined

  return (
    (proposal?.solar_project_id as string) ??
    (webProposal?.solar_project_id as string) ??
    (payload.solar_project_id as string) ??
    null
  )
}

export async function pylonWebhookRoute(fastify: FastifyInstance) {
  fastify.post('/pylon', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifyPylonSignature(req)) {
      return reply.code(401).send({ error: 'Invalid signature' })
    }

    reply.code(200).send({ received: true })

    const payload = req.body as PylonWebhookPayload
    const eventType = payload.event_type as string | undefined
    const eventId = `pylon-${payload.id ?? Date.now()}`

    if (!eventType) return

    const alreadyDone = await isEventProcessed(eventId)
    if (alreadyDone) return

    const pylonProjectId = extractProjectId(payload)

    if (eventType === 'proposals.shared') {
      await logEvent({
        eventId,
        direction: 'pylon_to_hs',
        eventType: 'proposals.shared',
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
