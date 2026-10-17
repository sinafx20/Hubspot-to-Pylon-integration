import {
  getCompany,
  getCompanyContacts,
  getCompanyDealIds,
  getDeal,
  getAssociatedContact,
  getAssociatedAccounts,
  updateCompanyProperties,
  createNote,
  type HubSpotCompany,
  type HubSpotContact,
} from '../services/hubspot'
import { createSolarProject, getSolarProject, archiveSolarProject, referenceFor } from '../services/pylon'
import { accountHasFields, accountInput, contactForAccount, fillEmptyAccountFromContact, isSite, rawInput, refreshDealSummary, runCheck, writeCheckToAccount } from '../services/address-sync'
import { formatAddress, type AddressCheck } from '../services/address'
import { getLinkByDealAccount, saveLink } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'

const GRADE_LABEL = { verified: '✅ Verified', check: '⚠️ Check', failed: '❌ Failed' }

// A deal/account deleted or merged before its (delayed) check runs: nothing to do, not a failure.
const isNotFound = (err: unknown) => /→ 404/.test((err as Error)?.message ?? '')
async function skipIfDeleted(what: string, work: () => Promise<void>) {
  try {
    await work()
  } catch (err) {
    if (!isNotFound(err)) throw err
    console.log(`[check-address] ${what} no longer exists (deleted or merged), skipping`)
  }
}

interface AccountJob {
  companyId: string
  eventId: string
  // 'address': the account's install_address was set/changed → check the new raw address
  // 'recheck': staff ticked "Re-check address" → check the (corrected) Pylon address fields and
  //            replace any of this property's Pylon projects that have the wrong address
  trigger: 'address' | 'recheck'
}

/** Check one account (property) and refresh the summary on every deal it's on. */
export async function handleCheckAccount(job: AccountJob) {
  await skipIfDeleted(`Account ${job.companyId}`, () => checkAccount(job))
}

async function checkAccount({ companyId, eventId, trigger }: AccountJob) {
  const [account, contacts, dealIds] = await Promise.all([getCompany(companyId), getCompanyContacts(companyId), getCompanyDealIds(companyId)])

  if (trigger === 'address' && !account.properties.install_address?.trim()) {
    console.log(`[check-account] Account ${companyId}: no install address yet, nothing to check`)
    return
  }

  const contact = contactForAccount(account, contacts)
  // A changed install address is a new raw address; a re-check verifies the corrected fields.
  // A re-check is staff confirming the address: remaining ⚠️ doubts are accepted (❌ still blocks).
  const check = await writeCheckToAccount(
    account,
    await runCheck(trigger === 'recheck' ? accountInput(account, contact) : rawInput(account, contact)),
    { confirm: trigger === 'recheck' }
  )
  console.log(`[check-account] Account ${companyId} (${trigger}): ${check.grade} → ${formatAddress(check.fields)}`)

  const outcomes: string[] = []
  if (trigger === 'recheck') {
    await updateCompanyProperties(companyId, { [config.HUBSPOT_ADDRESS_RECHECK_PROP]: 'false' })
    for (const dealId of dealIds) {
      const outcome = await fixPylonProjectIfNeeded(dealId, account, check)
      if (outcome) outcomes.push(outcome)
    }
    await createNote(
      `<p><b>Address re-checked: ${GRADE_LABEL[check.grade]}</b><br>${formatAddress(check.fields)}</p>` +
        `<p>${check.notes.join('<br>')}</p>${outcomes.map((o) => `<p>${o}</p>`).join('')}`,
      { companyId, dealId: dealIds[0] }
    )
  }
  for (const dealId of dealIds) await refreshDealSummary(dealId)

  await logEvent({
    eventId,
    direction: 'hs_to_pylon',
    eventType: `address.${trigger}`,
    status: 'success',
    errorMessage: `account ${companyId}: ${check.grade}${outcomes.length ? `; ${outcomes.join(' ')}` : ''}`,
  })
}

interface DealJob {
  dealId: string
  eventId: string
}

/**
 * A deal was created or entered an early stage: check any of its properties that haven't been
 * checked yet (never overwriting checked/corrected ones), then refresh the deal's summary.
 */
export async function handleCheckDeal(job: DealJob) {
  await skipIfDeleted(`Deal ${job.dealId}`, () => checkDeal(job))
}

async function checkDeal({ dealId, eventId }: DealJob) {
  const [accounts, contact] = await Promise.all([getAssociatedAccounts(dealId), getAssociatedContact(dealId)])
  await fillEmptyAccountFromContact(accounts, contact)
  for (const { company } of accounts) {
    if (!isSite(company) || accountHasFields(company)) continue
    const check = await runCheck(rawInput(company, contactForAccount(company, [contact])))
    await writeCheckToAccount(company, check)
    console.log(`[check-deal] Deal ${dealId} account ${company.id}: ${check.grade} → ${formatAddress(check.fields)}`)
  }
  await refreshDealSummary(dealId)
  await logEvent({ eventId, direction: 'hs_to_pylon', eventType: 'address.deal', hubspotDealId: dealId, status: 'success' })
}

const norm = (s?: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * If this deal already has a Pylon project for this property with a different (wrong) address,
 * replace it. Pylon can't edit a project's address or pin through the API, so the old project is
 * archived and a new one created; the link moves to the new project so quote/accept events keep
 * working. Confirmed projects (credits spent, maybe designs) are never replaced automatically.
 */
async function fixPylonProjectIfNeeded(dealId: string, account: HubSpotCompany, check: AddressCheck): Promise<string> {
  const link = await getLinkByDealAccount(dealId, account.id)
  if (!link) return '' // no project yet: the corrected fields are used at Ready to quote
  const label = `Deal ${dealId}:`
  if (check.grade === 'failed') return `${label} Pylon project NOT changed, because the address still fails the check.`

  const project = (await getSolarProject(link.pylon_project_id)) as any
  const sent = project.site_address ?? {}
  const f = check.fields
  const same =
    norm(sent.line1) === norm(f.line1) &&
    norm(sent.line2) === norm(f.unit ? `Unit ${f.unit}` : '') &&
    norm(sent.city) === norm(f.suburb) &&
    norm(sent.zip) === norm(f.postcode)
  if (same) return `${label} Pylon project already has this address, nothing to change.`

  if (project.is_committed && !project.is_archived) {
    return (
      `${label} Pylon project ${link.pylon_project_id} was NOT replaced because it's already confirmed in Pylon. ` +
      'Fix the address and pin in Pylon directly, or archive that project in Pylon and tick "Re-check address" again.'
    )
  }

  const [deal, contact] = await Promise.all([getDeal(dealId), getAssociatedContact(dealId)])
  const reference = referenceFor(deal, account)
  let archived = !!project.is_archived
  let newReference = reference
  if (!archived) {
    try {
      await archiveSolarProject(link.pylon_project_id, `${reference}-replaced-${Date.now()}`)
      archived = true
    } catch (err) {
      console.error(`[check-account] Could not archive Pylon project ${link.pylon_project_id}: ${(err as Error).message}`)
      newReference = `${reference}-v${Date.now()}` // avoid a clash with the old project's reference
    }
  }

  const replacement = await createSolarProject(deal, contact as HubSpotContact | null, account, check, newReference)
  await saveLink(dealId, account.id, replacement.id, link.is_primary)
  console.log(`[check-account] Deal ${dealId}: replaced Pylon project ${link.pylon_project_id} → ${replacement.id}`)

  return (
    `${label} Pylon project replaced with the corrected address (new project ${replacement.id}). ` +
    (archived
      ? `The old project ${link.pylon_project_id} has been archived.`
      : `Please archive the old project ${link.pylon_project_id} in Pylon by hand, it couldn't be archived automatically.`)
  )
}
