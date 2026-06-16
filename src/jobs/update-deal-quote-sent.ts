import { updateDealStage } from '../services/hubspot'
import { syncQuoteToDeal } from '../services/quote-sync'
import { getLinkByProjectId } from '../db/links'
import { logEvent, hasPriorQuoteSync } from '../db/events'
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
    // Project was not created via this integration (e.g. a Pylon-native project). Retrying
    // will never succeed, so skip cleanly instead of throwing and piling up dead jobs.
    console.warn(`[update-deal-quote-sent] No HubSpot deal linked to Pylon project ${pylonProjectId} — ignoring`)
    await logEvent({ eventId, direction: 'pylon_to_hs', eventType: 'proposals.shared', pylonProjectId, status: 'skipped' })
    return
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

  // A re-share of an already-synced quote is a revision — title the note "updated" not "sent".
  const isUpdate = await hasPriorQuoteSync(pylonProjectId, eventId)

  // Best-effort enrichment: line items, system specs, STC/rebate props, and an activity note
  // with the Pylon proposal link. Failures here must not fail the stage move (already done),
  // and must not trigger a retry that would duplicate line items / notes.
  try {
    await syncQuoteToDeal(link.hubspot_deal_id, pylonProjectId, { isUpdate })
    console.log(`[update-deal-quote-sent] Synced quote details to deal ${link.hubspot_deal_id} (${isUpdate ? 'revision' : 'first send'})`)
  } catch (err) {
    console.error(`[update-deal-quote-sent] Quote enrichment failed for deal ${link.hubspot_deal_id}:`, (err as Error).message)
  }
}
