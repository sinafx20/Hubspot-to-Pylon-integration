/**
 * Glue between the address check and HubSpot: where a deal's address comes from, and writing the
 * check result back onto the deal so the team sees it (and confirms it in the Ready to quote pop-up).
 */
import { updateDealProperties, type HubSpotCompany, type HubSpotContact, type HubSpotDeal } from './hubspot'
import { checkAddress, inputFromFields, inputFromRaw, type AddressCheck, type AddressInput } from './address'

// Deal properties (created by scripts/create-address-properties.ts).
export const P = {
  grade: 'address_check',
  notes: 'address_check_notes',
  map: 'address_check_map',
  line1: 'pylon_address_line1',
  unit: 'pylon_address_unit',
  suburb: 'pylon_address_suburb',
  state: 'pylon_address_state',
  postcode: 'pylon_address_postcode',
} as const
export const ADDRESS_DEAL_PROPS = Object.values(P)

const clean = (v?: string | null) => (v ?? '').trim() || undefined

/** True once the deal's Pylon address fields hold an address (pre-filled or typed by staff). */
export function dealHasAddressFields(deal: HubSpotDeal): boolean {
  return !!clean(deal.properties[P.line1])
}

/**
 * The address to check for the deal's PRIMARY site. The deal's Pylon address fields win once
 * they're filled (staff may have corrected them); otherwise the raw account/contact install line.
 */
export function primaryInput(
  deal: HubSpotDeal,
  account: HubSpotCompany | null,
  contact: HubSpotContact | null
): AddressInput | null {
  if (dealHasAddressFields(deal)) {
    const d = deal.properties
    return inputFromFields(
      { line1: d[P.line1], unit: d[P.unit], suburb: d[P.suburb], state: d[P.state], postcode: d[P.postcode] },
      "deal's Pylon address fields"
    )
  }
  return rawInput(account, contact, true)
}

/**
 * The raw install address for one account (property). The account's line is the source of truth;
 * the contact's line is used only when the account has none. The contact's postcode may back up
 * the primary/sole site only (a secondary property is a different site).
 */
export function rawInput(account: HubSpotCompany | null, contact: HubSpotContact | null, isPrimary: boolean): AddressInput | null {
  const acctLine = clean(account?.properties.install_address)
  const contactLine = clean(contact?.properties.install_address)
  const line = acctLine ?? (isPrimary ? contactLine : undefined) ?? clean(account?.properties.address)
  if (!line) return null
  const zips = [account?.properties.zip, ...(isPrimary ? [contact?.properties.zip] : [])]
  return inputFromRaw(line, zips, acctLine ? "account's install address" : "contact's install address")
}

export async function runCheck(input: AddressInput | null): Promise<AddressCheck> {
  if (input) return checkAddress(input)
  return {
    grade: 'failed',
    notes: ["❌ There's no install address on the deal's account or contact yet."],
    fields: { line1: '', unit: '', suburb: '', state: '', postcode: '' },
  }
}

/** Write the check onto the deal: grade, reasons, map link, and the standardised address fields. */
export async function writeCheckToDeal(dealId: string, check: AddressCheck): Promise<void> {
  const stamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium', timeStyle: 'short' })
  await updateDealProperties(dealId, {
    [P.grade]: check.grade,
    [P.notes]: [`Checked ${stamp}`, ...check.notes].join('\n'),
    [P.map]: check.mapUrl ?? '',
    [P.line1]: check.fields.line1,
    [P.unit]: check.fields.unit,
    [P.suburb]: check.fields.suburb,
    [P.state]: check.fields.state,
    [P.postcode]: check.fields.postcode,
  })
}
