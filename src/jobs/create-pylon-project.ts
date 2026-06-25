import { getDeal, getAssociatedContact, getAssociatedAccounts, updateDealProperties, type HubSpotCompany } from '../services/hubspot'
import { createSolarProject } from '../services/pylon'
import { saveLink, getLinkByDealAccount, hasPrimaryLink } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'

interface JobData {
  dealId: string
  eventId: string
  clearSyncFlag?: boolean // set when triggered by the pylon_sync_requested flag, so we reset it
}

/**
 * Create a Pylon project for EACH associated account (property) on the deal that doesn't have one
 * yet. The HubSpot-primary account's project is the anchor (drives the deal stage on the reverse
 * flow); secondary projects only leave notes. If no account has an install address, fall back to
 * a single contact-based project. Idempotent per (deal, account) — safe to re-run.
 */
export async function handleCreatePylonProject({ dealId, eventId, clearSyncFlag }: JobData) {
  const [deal, contact, accounts] = await Promise.all([
    getDeal(dealId),
    getAssociatedContact(dealId),
    getAssociatedAccounts(dealId),
  ])

  // Accounts that actually carry an install address are the property sites to sync.
  const withAddress = accounts.filter((a) => (a.company.properties.install_address ?? '').trim())

  console.log(
    `[create-pylon-project] Deal ${dealId}: ${accounts.length} account(s), ${withAddress.length} with an install address` +
      (contact ? '' : ' (no associated contact)')
  )

  // One project per account-with-address; if none, a single contact-based project (account null).
  const targets: (HubSpotCompany | null)[] = withAddress.length ? withAddress.map((a) => a.company) : [null]

  // Anchor = the HubSpot-primary account, else the first with-address account, else the contact
  // fallback. Only used the first time the deal gains an anchor; existing anchors are never demoted.
  const anchorAccountId = withAddress.find((a) => a.primary)?.company.id ?? withAddress[0]?.company.id ?? null

  let created = 0
  let skipped = 0
  for (const account of targets) {
    const accountId = account?.id ?? null
    if (await getLinkByDealAccount(dealId, accountId)) {
      skipped++
      continue
    }
    const isPrimary = accountId === anchorAccountId && !(await hasPrimaryLink(dealId))
    const project = await createSolarProject(deal, contact, account)
    await saveLink(dealId, accountId, project.id, isPrimary)
    created++
    console.log(
      `[create-pylon-project] Deal ${dealId} account ${accountId ?? 'contact'} → Pylon ${project.id}${isPrimary ? ' (primary/anchor)' : ''}`
    )
  }

  await logEvent({
    eventId,
    direction: 'hs_to_pylon',
    eventType: 'deal.ready_to_quote',
    hubspotDealId: dealId,
    status: created > 0 ? 'success' : 'duplicate',
  })

  // Reset the workflow flag so it can fire again next time an account is added.
  if (clearSyncFlag) {
    await updateDealProperties(dealId, { [config.HUBSPOT_SYNC_REQUESTED_PROP]: 'false' })
  }

  console.log(`[create-pylon-project] Deal ${dealId}: created ${created}, skipped ${skipped} (already linked)`)
}
