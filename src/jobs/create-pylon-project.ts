import { getDeal, getAssociatedContact } from '../services/hubspot'
import { createSolarProject } from '../services/pylon'
import { saveLink, getLinkByDealId } from '../db/links'
import { logEvent } from '../db/events'

interface JobData {
  dealId: string
  eventId: string
}

export async function handleCreatePylonProject({ dealId, eventId }: JobData) {
  // Idempotency — if we already created a project for this deal, skip
  const existingLink = await getLinkByDealId(dealId)
  if (existingLink) {
    console.log(`[create-pylon-project] Deal ${dealId} already linked to Pylon project ${existingLink.pylon_project_id}, skipping`)
    await logEvent({ eventId, direction: 'hs_to_pylon', eventType: 'deal.ready_to_quote', hubspotDealId: dealId, status: 'duplicate' })
    return
  }

  // Pull all deal data and the associated contact from HubSpot
  const [deal, contact] = await Promise.all([
    getDeal(dealId),
    getAssociatedContact(dealId),
  ])

  if (!contact) {
    console.warn(`[create-pylon-project] Deal ${dealId} has no associated contact — creating project without contact details`)
  }

  // Create the project in Pylon with full context from HubSpot
  const project = await createSolarProject(deal, contact)

  // Persist the link so Pylon→HS events can find the corresponding deal
  await saveLink(dealId, project.id)

  await logEvent({
    eventId,
    direction: 'hs_to_pylon',
    eventType: 'deal.ready_to_quote',
    hubspotDealId: dealId,
    pylonProjectId: project.id,
    status: 'success',
  })

  console.log(`[create-pylon-project] Created Pylon project ${project.id} for HubSpot deal ${dealId}`)
}
