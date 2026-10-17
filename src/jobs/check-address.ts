import { getDeal, getAssociatedContact, getAssociatedAccounts, updateDealProperties, createNote } from '../services/hubspot'
import { createSolarProject, getSolarProject, archiveSolarProject, referenceFor } from '../services/pylon'
import { dealHasAddressFields, primaryInput, runCheck, writeCheckToDeal } from '../services/address-sync'
import { formatAddress, type AddressCheck } from '../services/address'
import { getLinksByDealId, saveLink } from '../db/links'
import { logEvent } from '../db/events'
import { config } from '../config'

interface JobData {
  dealId: string
  eventId: string
  // 'stage':   deal entered an early stage, pre-fill the Pylon address fields (never overwrites)
  // 'recheck': staff ticked "Re-check address", re-check the fields and fix Pylon if needed
  trigger: 'stage' | 'recheck'
}

const GRADE_LABEL = { verified: '✅ Verified', check: '⚠️ Check', failed: '❌ Failed' }

/**
 * Check the deal's primary site address and write the result onto the deal. On a re-check, if the
 * deal already has a Pylon project with a different (wrong) address, replace it: Pylon can't edit
 * a project's address or pin through the API, so the old project is archived and a new one
 * created, and the deal's link moves to the new project so quote/accept events keep working.
 */
export async function handleCheckAddress({ dealId, eventId, trigger }: JobData) {
  const [deal, contact, accounts] = await Promise.all([getDeal(dealId), getAssociatedContact(dealId), getAssociatedAccounts(dealId)])

  // Stage trigger only pre-fills: once the fields hold an address (maybe corrected by staff),
  // leave them alone. Staff use the re-check box to re-run on purpose.
  if (trigger === 'stage' && dealHasAddressFields(deal)) {
    console.log(`[check-address] Deal ${dealId}: address fields already filled, not overwriting`)
    return
  }

  const withAddress = accounts.filter((a) => (a.company.properties.install_address ?? '').trim())
  const primary = withAddress.find((a) => a.primary)?.company ?? withAddress[0]?.company ?? accounts.find((a) => a.primary)?.company ?? null
  const check = await runCheck(primaryInput(deal, primary, contact))
  await writeCheckToDeal(dealId, check)
  console.log(`[check-address] Deal ${dealId} (${trigger}): ${check.grade} → ${formatAddress(check.fields)}`)

  let outcome = ''
  if (trigger === 'recheck') {
    await updateDealProperties(dealId, { [config.HUBSPOT_ADDRESS_RECHECK_PROP]: 'false' })
    outcome = await fixPylonProjectIfNeeded(dealId, deal, contact, accounts.map((a) => a.company), check)
    await createNote(
      `<p><b>Address re-checked: ${GRADE_LABEL[check.grade]}</b><br>${formatAddress(check.fields)}</p>` +
        `<p>${check.notes.join('<br>')}</p>${outcome ? `<p>${outcome}</p>` : ''}`,
      { dealId }
    )
  }

  await logEvent({
    eventId,
    direction: 'hs_to_pylon',
    eventType: `address.${trigger}`,
    hubspotDealId: dealId,
    status: 'success',
    errorMessage: `${check.grade}${outcome ? `; ${outcome.replace(/<[^>]+>/g, '')}` : ''}`,
  })
}

const norm = (s?: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

async function fixPylonProjectIfNeeded(
  dealId: string,
  deal: Awaited<ReturnType<typeof getDeal>>,
  contact: Awaited<ReturnType<typeof getAssociatedContact>>,
  accounts: Awaited<ReturnType<typeof getAssociatedAccounts>>[number]['company'][],
  check: AddressCheck
): Promise<string> {
  const link = (await getLinksByDealId(dealId)).find((l) => l.is_primary)
  if (!link) return '' // no project yet: the corrected fields will be used at Ready to quote
  if (check.grade === 'failed') return 'Pylon project NOT changed, because the address still fails the check.'

  const project = (await getSolarProject(link.pylon_project_id)) as any
  const sent = project.site_address ?? {}
  const f = check.fields
  const same =
    norm(sent.line1) === norm(f.line1) &&
    norm(sent.line2) === norm(f.unit ? `Unit ${f.unit}` : '') &&
    norm(sent.city) === norm(f.suburb) &&
    norm(sent.zip) === norm(f.postcode)
  if (same) return 'Pylon project already has this address, nothing to change.'

  if (project.is_committed && !project.is_archived) {
    // Confirmed projects have used credits and may have designs/proposals: never auto-replace.
    return (
      `Pylon project ${link.pylon_project_id} was NOT replaced because it's already confirmed in Pylon. ` +
      'Fix the address and pin in Pylon directly, or archive that project in Pylon and tick "Re-check address" again.'
    )
  }

  // The replacement belongs to the same account slot as the old project.
  const account = accounts.find((a) => a.id === link.hubspot_account_id) ?? null
  if (link.hubspot_account_id && !account) {
    return `Pylon project NOT replaced: its account ${link.hubspot_account_id} is no longer on this deal.`
  }

  // Free the reference on the old project first (archive it), then create the replacement.
  const reference = referenceFor(deal, account)
  let archived = !!project.is_archived
  let newReference = reference
  if (!archived) {
    try {
      await archiveSolarProject(link.pylon_project_id, `${reference}-replaced-${Date.now()}`)
      archived = true
    } catch (err) {
      console.error(`[check-address] Could not archive Pylon project ${link.pylon_project_id}: ${(err as Error).message}`)
      newReference = `${reference}-v${Date.now()}` // avoid a clash with the old project's reference
    }
  }

  const replacement = await createSolarProject(deal, contact, account, check, newReference)
  await saveLink(dealId, link.hubspot_account_id, replacement.id, true)
  console.log(`[check-address] Deal ${dealId}: replaced Pylon project ${link.pylon_project_id} → ${replacement.id}`)

  return (
    `Pylon project replaced with the corrected address (new project ${replacement.id}). ` +
    (archived
      ? `The old project ${link.pylon_project_id} has been archived.`
      : `Please archive the old project ${link.pylon_project_id} in Pylon by hand, it couldn't be archived automatically.`)
  )
}
