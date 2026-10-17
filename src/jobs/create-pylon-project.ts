import { getDeal, getAssociatedContact, getAssociatedAccounts, updateDealProperties, type HubSpotCompany } from '../services/hubspot'
import { createSolarProject } from '../services/pylon'
import { accountInput, contactForAccount, fillEmptyAccountFromContact, rawInput, refreshDealSummary, runCheck, writeCheckToAccount } from '../services/address-sync'
import { formatAddress, type AddressCheck } from '../services/address'
import { saveLink, getLinkByDealAccount, hasPrimaryLink } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'
import { UnrecoverableError } from 'bullmq'

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
 *
 * Every property's address is checked first (services/address.ts), from the account's Pylon address
 * fields once filled (staff may have corrected them), else its raw install line. Each check is
 * written back to its account and the deal's summary is refreshed. If ANY property fails its
 * check, nothing is created, so a deal never ends up half-synced with a wrong address.
 */
export async function handleCreatePylonProject({ dealId, eventId, clearSyncFlag }: JobData) {
  const [deal, contact, accounts] = await Promise.all([
    getDeal(dealId),
    getAssociatedContact(dealId),
    getAssociatedAccounts(dealId),
  ])

  // An account created without its address (manual form, or by hand) gets the contact's, so the
  // project is made from the account rather than falling back to a contact-only project.
  await fillEmptyAccountFromContact(accounts, contact).catch((err) =>
    console.error(`[create-pylon-project] Could not fill the empty account from the contact: ${err.message}`)
  )

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

  // 1. Check every not-yet-synced site before creating anything.
  const pending: { account: HubSpotCompany | null; isPrimary: boolean; check: AddressCheck }[] = []
  let skipped = 0
  for (const account of targets) {
    const accountId = account?.id ?? null
    if (await getLinkByDealAccount(dealId, accountId)) {
      skipped++
      continue
    }
    const isPrimary = accountId === anchorAccountId && !(await hasPrimaryLink(dealId))
    const check = await runCheck(account ? accountInput(account, contactForAccount(account, [contact])) : rawInput(null, contact))
    // Showing the result on the account is best-effort: it must never block the Pylon project.
    if (account) await writeCheckToAccount(account, check).catch((err) => console.error(`[create-pylon-project] Could not write address check to account ${account.id}: ${err.message}`))
    pending.push({ account, isPrimary, check })
  }
  await refreshDealSummary(dealId).catch((err) => console.error(`[create-pylon-project] Could not refresh address summary on deal ${dealId}: ${err.message}`))

  const failed = pending.filter((p) => p.check.grade === 'failed')
  if (failed.length) {
    const detail = failed
      .map((p) => `${p.account ? `account ${p.account.id}` : 'contact'}: ${p.check.notes.filter((n) => n.startsWith('❌')).join(' ')}`)
      .join(' | ')
    await logEvent({ eventId, direction: 'hs_to_pylon', eventType: 'deal.ready_to_quote', hubspotDealId: dealId, status: 'failed', errorMessage: detail })
    throw new UnrecoverableError(
      `Address check failed for deal ${dealId}, no Pylon project created. ${detail} ` +
        `Fix the Pylon address fields on the flagged account, then tick "Re-check address" or click Retry.`
    )
  }

  // 2. Create the projects from the checked, standardised addresses.
  let created = 0
  for (const { account, isPrimary, check } of pending) {
    const accountId = account?.id ?? null
    const project = await createSolarProject(deal, contact, account, check)
    await saveLink(dealId, accountId, project.id, isPrimary)
    created++
    console.log(
      `[create-pylon-project] Deal ${dealId} account ${accountId ?? 'contact'} → Pylon ${project.id} ` +
        `(${check.grade}: ${formatAddress(check.fields)})${isPrimary ? ' (primary/anchor)' : ''}`
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
