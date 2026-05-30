import { updateDealStage } from '../services/hubspot'
import { getLinkByProjectId } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'

interface JobData {
  pylonProjectId: string | null
  eventId: string
}

export async function handleUpdateDealQuoteSent({ pylonProjectId, eventId }: JobData) {
  if (!pylonProjectId) {
    throw new Error('proposals.shared event received without a project ID — check extractProjectId() in pylon webhook handler')
  }

  const link = await getLinkByProjectId(pylonProjectId)
  if (!link) {
    throw new Error(`No HubSpot deal linked to Pylon project ${pylonProjectId} — project may have been created outside this integration`)
  }

  await updateDealStage(link.hubspot_deal_id, config.HUBSPOT_STAGE_QUOTE_SENT)

  await logEvent({
    eventId,
    direction: 'pylon_to_hs',
    eventType: 'proposals.shared',
    hubspotDealId: link.hubspot_deal_id,
    pylonProjectId,
    status: 'success',
  })

  console.log(`[update-deal-quote-sent] Deal ${link.hubspot_deal_id} moved to Quote Sent`)
}
