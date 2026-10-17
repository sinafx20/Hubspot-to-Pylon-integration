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

    const checkStages = config.HUBSPOT_ADDRESS_CHECK_STAGES.split(',').map((s) => s.trim())

    for (const event of events) {
      // Address check triggers (services/address.ts). The account (property) is the source of truth:
      //  - account created, or its install_address changed → check that property's new address
      //  - staff ticked "Re-check address" on an account     → re-check its corrected fields, and
      //                                                        replace a Pylon project with a wrong address
      //  - deal created, or entered an early stage           → check its not-yet-checked properties.
      //    Delayed, because the form workflow copies the address onto the account a minute later.
      const type = event.subscriptionType
      const prop = event.propertyName
      const isAccountAddress =
        type === 'company.creation' || (type === 'company.propertyChange' && prop === 'install_address' && !!event.propertyValue)
      const isAccountRecheck = type === 'company.propertyChange' && prop === config.HUBSPOT_ADDRESS_RECHECK_PROP && event.propertyValue === 'true'
      const isDealCheck =
        type === 'deal.creation' || (type === 'deal.propertyChange' && prop === 'dealstage' && checkStages.includes(event.propertyValue ?? ''))
      if (isAccountAddress || isAccountRecheck || isDealCheck) {
        const eventId = `hs-${event.eventId}`
        if (await isEventProcessed(eventId)) continue
        const id = String(event.objectId)
        const jobOpts = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5000 }, removeOnComplete: { count: 100 }, removeOnFail: false }
        if (isDealCheck) {
          await logEvent({ eventId, direction: 'hs_to_pylon', eventType: 'address.deal', hubspotDealId: id, status: 'queued' })
          // Creation and entering an early stage arrive together: one check per deal per 10 minutes.
          // (Not a fixed id, because the queue keeps finished jobs and would block later checks.)
          const jobId = `check-deal-${id}-${Math.floor(Date.now() / 600_000)}`
          await integrationQueue.add('check-deal', { dealId: id, eventId }, { ...jobOpts, delay: config.ADDRESS_CHECK_DELAY_MS, jobId })
        } else {
          const trigger = isAccountRecheck ? 'recheck' : 'address'
          await logEvent({ eventId, direction: 'hs_to_pylon', eventType: `address.${trigger}`, status: 'queued', errorMessage: `account ${id}` })
          // A new account gets its install address from a workflow a moment later: give it time.
          await integrationQueue.add('check-account', { companyId: id, eventId, trigger }, { ...jobOpts, delay: type === 'company.creation' ? 90_000 : 0 })
        }
        continue
      }

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
