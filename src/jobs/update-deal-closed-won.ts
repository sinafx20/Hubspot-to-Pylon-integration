import { updateDealStage } from '../services/hubspot'
import { getLinkByProjectId } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'

interface JobData {
  pylonProjectId: string | null
  eventId: string
}

export async function handleUpdateDealClosedWon({ pylonProjectId, eventId }: JobData) {
  if (!pylonProjectId) {
    throw new Error('web_proposals.signed event received without a project ID — check extractProjectId() in pylon webhook handler')
  }

  const link = await getLinkByProjectId(pylonProjectId)
  if (!link) {
    throw new Error(`No HubSpot deal linked to Pylon project ${pylonProjectId}`)
  }

  await updateDealStage(link.hubspot_deal_id, config.HUBSPOT_STAGE_CLOSED_WON)

  await logEvent({
    eventId,
    direction: 'pylon_to_hs',
    eventType: 'web_proposals.signed',
    hubspotDealId: link.hubspot_deal_id,
    pylonProjectId,
    status: 'success',
  })

  console.log(`[update-deal-closed-won] Deal ${link.hubspot_deal_id} moved to Closed Won`)
}
