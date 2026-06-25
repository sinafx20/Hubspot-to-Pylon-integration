import { UnrecoverableError } from 'bullmq'
import { config } from '../config'
import type { HubSpotContact, HubSpotCompany, HubSpotDeal } from './hubspot'
import {
  searchCandidates,
  parseUnit,
  normalizeAddressLine,
  extractPostcode,
  cleanPostcode,
  type GeoCandidate,
} from './geocode'

// Trim a HubSpot value and treat blank strings as "absent" (HubSpot returns '' or null
// for empty properties, both of which Pylon rejects when a real value is required).
const clean = (v?: string | null): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

const BASE = 'https://api.getpylon.com/v1'

const headers = () => ({
  Authorization: `Bearer ${config.PYLON_API_TOKEN}`,
  'Content-Type': 'application/vnd.api+json',
  Accept: 'application/vnd.api+json',
})

interface JsonApiResponse<T> {
  data: {
    id: string
    type: string
    attributes: T
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<JsonApiResponse<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Pylon API ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<JsonApiResponse<T>>
}

export interface PylonProject {
  id: string
  [key: string]: unknown
}

// Geocode the deal's site address from the cleaned address parts. Returns the full candidate
// (not just coords) so the caller can backfill a blank suburb/postcode from the normalised result.
//
// Addresses here typically arrive as ONE free-text line in `install_address` (street + suburb,
// e.g. "11 Dewpond Dr TRUGANINA"), with the structured city/zip fields blank. So we geocode the
// (unit-stripped, normalised) line FIRST for the exact rooftop. The layered fallbacks guarantee a
// usable pin: structured matching, then a suburb centroid from any postcode we can find, so a
// deal still syncs (with a coarse pin) instead of failing outright.
async function geocodeSite(o: {
  street?: string
  city?: string
  state?: string
  postcode?: string
  extraFree?: string[]
}): Promise<GeoCandidate | null> {
  const { street, city, state, postcode } = o

  // 1. Precise free-text on the cleaned street line. If the line itself has no postcode, try it
  //    postcode-qualified first — a bare "25 raymond" can match the wrong state, but
  //    "25 raymond 3912" pins the right suburb.
  if (street) {
    const queries: string[] = []
    if (!extractPostcode(street) && postcode) queries.push(`${street} ${postcode}`)
    queries.push(street)
    for (const q of queries) {
      const [found] = await searchCandidates({ free: q }, 1)
      if (found) {
        console.log(`[pylon] Geocoded (${found.precision}) "${q}" → [${found.lon},${found.lat}]`)
        return found
      }
    }
  }

  // 2. Structured matching: rooftop when street+postcode align, else a suburb centroid from the
  //    postcode — robust when the line is messy/blank but clean city/postcode fields exist.
  const structured = await searchCandidates({ parts: { street, city, state, postcode } })
  if (structured.length) {
    console.log(`[pylon] Geocoded (${structured[0].precision}) "${structured[0].display}"`)
    return structured[0]
  }

  // 3. Last resort: other free-text candidates (company name often holds the full site address).
  for (const candidate of o.extraFree ?? []) {
    const [found] = await searchCandidates({ free: candidate }, 1)
    if (found) {
      console.log(`[pylon] Geocoded (${found.precision}) "${candidate}" → [${found.lon},${found.lat}]`)
      return found
    }
  }
  return null
}

// Build the Pylon solar_projects payload from HubSpot data (geocoding + validation included).
// Separated from the POST so it can be dry-run/inspected without writing to Pylon.
export async function buildSolarProjectPayload(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  account: HubSpotCompany | null,
  opts: { borrowContactPostcode?: boolean } = {}
) {
  const c = contact?.properties
  const co = account?.properties // the Account (= property/site) — primary address source

  // 1. Pick the address SOURCE and read the LINE + structured city/state from the same object.
  //    The account is a distinct property/site, so we must NEVER take the account's install line
  //    and the contact's CITY together — a contact city name strongly biases the geocoder to the
  //    wrong town (account "131 Beatts Rd, Allingham 4850" + contact city "Kirwan" → wrongly Kirwan).
  const acctLine = clean(co?.install_address)
  const contactLine = clean(c?.install_address)
  const fromAccount = !!acctLine || !contactLine // account is the source unless only the contact has a line
  const src = fromAccount ? co : c

  // Parse the single-line install address: split off any unit (6/, U6, Unit 6, …) and clean the
  // street for geocoding. The unit is removed for geocoding (Nominatim fails on "6/123 …") but
  // kept for the Pylon address line2.
  const rawLine = acctLine ?? contactLine ?? clean(co?.address)
  const parsed = rawLine ? parseUnit(rawLine) : { street: undefined as string | undefined, unit: undefined as string | undefined }
  const cleanStreet = parsed.street ? normalizeAddressLine(parsed.street) : undefined

  // Postcode/suburb: the install LINE is the source of truth, then the SOURCE's structured zip.
  // As a LAST resort, the contact's postcode may backfill a sole/primary account whose line has
  // no postcode (same property) — postcode only, never the city, and never for a secondary account.
  const cityIn = clean(src?.city)
  const stateIn = clean(src?.state)
  const borrowedPostcode =
    fromAccount && (opts.borrowContactPostcode ?? true) ? cleanPostcode(c?.zip) : undefined
  const postcodeIn = extractPostcode(rawLine) ?? cleanPostcode(src?.zip) ?? borrowedPostcode

  // 2. Geocode — Pylon requires coordinates AND a non-empty city/zip, and the geocoder's
  //    normalised result lets us backfill a suburb/postcode that's blank in HubSpot.
  const companyNameStreet = co?.name?.includes(';') ? co.name.split(';')[0].trim() : clean(co?.name)
  const extraFree = (fromAccount ? [co?.name, co?.address] : [c?.address]).map(clean).filter(Boolean) as string[]
  const geo = await geocodeSite({ street: cleanStreet, city: cityIn, state: stateIn, postcode: postcodeIn, extraFree })

  // 3. Build the site address, preferring HubSpot/line data and backfilling from the geocode
  //    result. c.address is the contact's *personal* address, not the install site, so it's only
  //    a last resort for line1.
  const street = cleanStreet ?? clean(co?.address) ?? companyNameStreet
  const unitLine = parsed.unit ? `Unit ${parsed.unit}` : ''
  const city = cityIn ?? clean(geo?.components.city)
  const state = stateIn ?? clean(geo?.components.state)
  const zip = postcodeIn ?? clean(geo?.components.postcode)
  const country = clean(src?.country) ?? 'Australia'

  // 3. Customer details — only include fields we actually have. Pylon rejects an explicit
  //    null (e.g. phone: null), so omit empties entirely rather than sending null.
  const customer_details: { name?: string; email?: string; phone?: string } = {}
  const name = [clean(c?.firstname), clean(c?.lastname)].filter(Boolean).join(' ')
  if (name) customer_details.name = name
  const email = clean(c?.email)
  if (email) customer_details.email = email
  const phone = clean(c?.phone) ?? clean(c?.mobilephone)
  if (phone) customer_details.phone = phone

  // 4. Validate before POSTing. An incomplete record can NEVER succeed on retry — failing fast
  //    and non-retryably surfaces it on the dashboard for staff to fix, instead of hammering
  //    Pylon 5× with a doomed payload (see the dashboard's address-suggestion box).
  const missing: string[] = []
  if (!geo) missing.push('a valid street address (we could not find it on the map)')
  if (!city) missing.push('suburb/city')
  if (!zip) missing.push('postcode')
  if (missing.length) {
    throw new UnrecoverableError(
      `Incomplete address for deal ${deal.id}: missing ${missing.join(', ')}. ` +
        `Fix the contact's Install Address, suburb and postcode in HubSpot, then click Retry.`
    )
  }

  return {
    data: {
      type: 'solar_projects',
      attributes: {
        reference_number: account ? `HS-${deal.id}-${account.id}` : `HS-${deal.id}`,
        is_committed: false,
        site_location: [geo!.lon, geo!.lat] as [number, number],
        customer_details,
        site_address: { line1: street ?? '', line2: unitLine, city, state: state ?? '', zip, country },
      },
    },
  }
}

export async function createSolarProject(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  account: HubSpotCompany | null,
  opts: { borrowContactPostcode?: boolean } = {}
): Promise<PylonProject> {
  const payload = await buildSolarProjectPayload(deal, contact, account, opts)

  // Avoid logging the full payload — it contains customer PII (name, email, address).
  console.log(`[pylon] Creating solar project for deal ${deal.id}`)
  const res = await request<Record<string, unknown>>('POST', '/solar_projects', payload)
  return { id: res.data.id, ...res.data.attributes }
}

export async function getSolarProject(pylonProjectId: string): Promise<PylonProject> {
  const res = await request<Record<string, unknown>>('GET', `/solar_projects/${pylonProjectId}`)
  return { id: res.data.id, ...res.data.attributes }
}

// ---- Quote / design data (used to sync line items + specs back to HubSpot) ----

export interface PylonLineItem {
  key: string
  // 'subtotal' = product/service line, 'amount_payable' = rebate/loan, 'total' = STC, 'none' = hidden/note
  included_in_summary_line: string
  description: string
  unit_amount: number | null // cents, ex-tax (may be fractional)
  quantity: number | null
  total_amount: number | null // cents
  tax_rate: number | null
  tax_amount: number | null
  is_line_hidden: boolean
  is_amount_hidden: boolean
  component_type: string | null
  component_id: string | null
}

export interface PylonComponentType {
  sku: string
  description: string
  quantity: number
}

export interface PylonDesign {
  id: string
  summary: {
    dc_output_kw?: number
    storage_kwh?: number
    description?: string
    web_proposal_url?: string
    pdf_proposal_url?: string
    [key: string]: unknown
  }
  pricing: { total: number; currency: string; total_includes_tax: boolean } | null
  line_items: PylonLineItem[]
  module_types: PylonComponentType[]
  inverter_types: PylonComponentType[]
  storage_types: PylonComponentType[]
}

interface DesignAttributes extends Omit<PylonDesign, 'id'> {}

// Raw fetch that preserves JSON:API relationships (the typed `request` helper drops them).
async function rawGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method: 'GET', headers: headers() })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Pylon API GET ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

const DESIGN_FIELDS = 'summary,pricing,line_items,module_types,inverter_types,storage_types'

/**
 * Resolve a project's primary design and return its quote data (line items, pricing, specs).
 * Returns null if the project has no primary design yet.
 */
export async function getPrimaryDesign(pylonProjectId: string): Promise<PylonDesign | null> {
  const project = await rawGet(`/solar_projects/${pylonProjectId}`)
  const designId: string | undefined =
    project?.data?.relationships?.primary_design?.data?.id

  if (!designId) {
    console.warn(`[pylon] Project ${pylonProjectId} has no primary_design — skipping quote sync`)
    return null
  }

  const res = await request<DesignAttributes>(
    'GET',
    `/solar_designs/${designId}?fields%5Bsolar_designs%5D=${DESIGN_FIELDS}`
  )

  const a = res.data.attributes
  return {
    id: res.data.id,
    summary: a.summary ?? {},
    pricing: a.pricing ?? null,
    line_items: a.line_items ?? [],
    module_types: a.module_types ?? [],
    inverter_types: a.inverter_types ?? [],
    storage_types: a.storage_types ?? [],
  }
}
