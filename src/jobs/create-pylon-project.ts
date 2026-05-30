import { getDeal, getAssociatedContact, getAssociatedCompany } from '../services/hubspot'
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

  const [deal, contact, company] = await Promise.all([
    getDeal(dealId),
    getAssociatedContact(dealId),
    getAssociatedCompany(dealId),
  ])

  console.log('[create-pylon-project] DEAL:', JSON.stringify(deal.properties, null, 2))
  console.log('[create-pylon-project] CONTACT:', JSON.stringify(contact?.properties ?? null, null, 2))
  console.log('[create-pylon-project] COMPANY:', JSON.stringify(company?.properties ?? null, null, 2))

  if (!contact) {
    console.warn(`[create-pylon-project] Deal ${dealId} has no associated contact — creating project without contact details`)
  }

  const project = await createSolarProject(deal, contact, company)

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
