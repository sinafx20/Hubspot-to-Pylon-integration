/**
 * Glue between the address check and HubSpot. The ACCOUNT (company) is the source of truth: one
 * account = one property = one Pylon project. Each account holds its own checked, standardised
 * address; the deal shows a read-only summary of all its properties.
 */
import {
  getAssociatedAccounts,
  getAssociatedContact,
  getDeal,
  updateCompanyProperties,
  updateDealProperties,
  type HubSpotCompany,
  type HubSpotContact,
} from './hubspot'
import { checkAddress, formatAddress, inputFromFields, inputFromRaw, type AddressCheck, type AddressInput, type Grade } from './address'

// Account (company) properties, created by scripts/create-address-properties.ts.
export const A = {
  grade: 'address_check',
  notes: 'address_check_notes',
  map: 'address_check_map',
  line1: 'pylon_address_line1',
  unit: 'pylon_address_unit',
  suburb: 'pylon_address_suburb',
  state: 'pylon_address_state',
  postcode: 'pylon_address_postcode',
} as const

// Deal properties: overall grade (worst property) and a one-line-per-property summary.
export const D = { grade: 'address_check', sites: 'pylon_sites', confirmed: 'pylon_addresses_confirmed' } as const

const clean = (v?: string | null) => (v ?? '').trim() || undefined
const norm = (v?: string | null) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** True once the account's Pylon address fields hold an address (pre-filled or corrected). */
export function accountHasFields(account: HubSpotCompany): boolean {
  return !!clean(account.properties[A.line1])
}

/** The account is a site worth syncing if it has a raw install address or checked fields. */
export function isSite(account: HubSpotCompany): boolean {
  return !!clean(account.properties.install_address) || accountHasFields(account)
}

/**
 * A contact describing the SAME property as the account (same install line), whose separate
 * postcode field can back up a line typed without one. Never another property's contact.
 */
export function contactForAccount(account: HubSpotCompany, contacts: (HubSpotContact | null)[]): HubSpotContact | null {
  const line = norm(account.properties.install_address)
  if (!line) return null
  return contacts.find((c) => c && norm(c.properties.install_address) === line) ?? null
}

/** The raw install address of an account, or (contact-only deals) of the contact. */
export function rawInput(account: HubSpotCompany | null, contact: HubSpotContact | null): AddressInput | null {
  if (account) {
    const line = clean(account.properties.install_address)
    if (!line) return null
    return inputFromRaw(line, [account.properties.zip, contact?.properties.zip], "account's install address")
  }
  const line = clean(contact?.properties.install_address)
  return line ? inputFromRaw(line, [contact?.properties.zip], "contact's install address") : null
}

/** The account's Pylon address fields once filled (staff may have corrected them), else its raw line. */
export function accountInput(account: HubSpotCompany, contact: HubSpotContact | null): AddressInput | null {
  if (!accountHasFields(account)) return rawInput(account, contact)
  const p = account.properties
  return inputFromFields(
    { line1: p[A.line1], unit: p[A.unit], suburb: p[A.suburb], state: p[A.state], postcode: p[A.postcode] },
    "account's Pylon address fields"
  )
}

export async function runCheck(input: AddressInput | null): Promise<AddressCheck> {
  if (input) return checkAddress(input)
  return {
    grade: 'failed',
    notes: ["❌ There's no install address on this property yet."],
    fields: { line1: '', unit: '', suburb: '', state: '', postcode: '' },
  }
}

/** Write the check onto the account and keep the in-memory copy in step with what was written. */
export async function writeCheckToAccount(account: HubSpotCompany, check: AddressCheck): Promise<void> {
  const stamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium', timeStyle: 'short' })
  const props: Record<string, string> = {
    [A.grade]: check.grade,
    [A.notes]: [`Checked ${stamp}`, ...check.notes].join('\n'),
    [A.map]: check.mapUrl ?? '',
    [A.line1]: check.fields.line1,
    [A.unit]: check.fields.unit,
    [A.suburb]: check.fields.suburb,
    [A.state]: check.fields.state,
    [A.postcode]: check.fields.postcode,
  }
  // Accounts are named after their address: keep the name in step with the clean address, so the
  // account card on the deal reads "43 Bassetts Road, Doreen VIC 3754". Non-address names are kept.
  const name = account.properties.name ?? ''
  if (check.grade !== 'failed' && check.fields.line1 && (!name.trim() || /\d/.test(name))) {
    props.name = formatAddress(check.fields)
  }
  await updateCompanyProperties(account.id, props)
  Object.assign(account.properties, props)
}

const ICON: Record<Grade, string> = { verified: '✅', check: '⚠️', failed: '❌' }
const RANK: Grade[] = ['failed', 'check', 'verified']

/**
 * Rebuild the deal's read-only summary from its accounts' stored checks: one line per property,
 * plus the overall grade (the worst property). This is what staff review before Ready to quote.
 */
export async function refreshDealSummary(dealId: string): Promise<void> {
  const [deal, accounts, contact] = await Promise.all([getDeal(dealId), getAssociatedAccounts(dealId), getAssociatedContact(dealId)])
  const sites = accounts.filter((a) => isSite(a.company))
  const lines: string[] = []
  const grades: Grade[] = []

  for (const { company, primary } of sites.sort((a, b) => Number(b.primary) - Number(a.primary))) {
    const p = company.properties
    const grade = p[A.grade] as Grade | undefined
    if (!grade) {
      lines.push(`⏳ ${p.install_address} (not checked yet)${primary ? ' (primary)' : ''}`)
      continue
    }
    grades.push(grade)
    const address = formatAddress({ line1: p[A.line1] ?? '', unit: p[A.unit] ?? '', suburb: p[A.suburb] ?? '', state: p[A.state] ?? '', postcode: p[A.postcode] ?? '' })
    const reason = grade === 'verified' ? '' : ` (${(p[A.notes] ?? '').split('\n').find((l) => l.startsWith('❌') || l.startsWith('⚠️'))?.slice(2).trim() ?? 'see account'})`
    lines.push(`${ICON[grade]} ${address}${primary ? ' (primary)' : ''}${reason}`)
  }

  if (!sites.length) {
    // Contact-only deal: summarise the contact's line, checked on the fly.
    const check = await runCheck(rawInput(null, contact))
    grades.push(check.grade)
    lines.push(`${ICON[check.grade]} ${formatAddress(check.fields) || 'No install address'} (from the contact, no property account)`)
  }

  const worst = RANK.find((g) => grades.includes(g)) ?? ''
  const sitesText = lines.join('\n')
  const update: Record<string, string> = { [D.grade]: worst, [D.sites]: sitesText }
  // A confirmation is only for the addresses that were on screen: if they changed, untick it.
  if ((deal.properties[D.sites] ?? '') !== sitesText && deal.properties[D.confirmed] === 'true') update[D.confirmed] = 'false'
  await updateDealProperties(dealId, update)
}
