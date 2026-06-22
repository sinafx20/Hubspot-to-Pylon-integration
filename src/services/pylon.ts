import { UnrecoverableError } from 'bullmq'
import { config } from '../config'
import type { HubSpotContact, HubSpotCompany, HubSpotDeal } from './hubspot'
import { searchCandidates, type GeoCandidate } from './geocode'

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

// Geocode the deal's site address. Structured geocoding (street/suburb/state/postcode as
// separate fields) is much more robust than a free-text blob and self-recovers from a messy
// street by falling back to the suburb centroid. We return the full candidate (not just
// coords) so the caller can backfill a blank suburb/postcode from the normalised result.
async function geocodeSite(
  c: HubSpotContact['properties'] | undefined,
  co: HubSpotCompany['properties'] | undefined
): Promise<GeoCandidate | null> {
  const structured = await searchCandidates({
    parts: {
      street: clean(c?.install_address) ?? clean(co?.address),
      city: clean(c?.city) ?? clean(co?.city),
      state: clean(c?.state) ?? clean(co?.state),
      postcode: clean(c?.zip) ?? clean(co?.zip),
    },
  })
  if (structured.length) {
    console.log(`[pylon] Geocoded (${structured[0].precision}) "${structured[0].display}"`)
    return structured[0]
  }

  // Fall back to free-text candidates (e.g. company name often holds the full site address).
  const freeCandidates = [c?.install_address, co?.name, c?.address, co?.address]
    .map(clean)
    .filter(Boolean) as string[]
  for (const candidate of freeCandidates) {
    const [found] = await searchCandidates({ free: candidate }, 1)
    if (found) {
      console.log(`[pylon] Geocoded (free-text) "${candidate}" → [${found.lon},${found.lat}]`)
      return found
    }
  }
  return null
}

export async function createSolarProject(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  company: HubSpotCompany | null
): Promise<PylonProject> {
  const c = contact?.properties
  const co = company?.properties

  // 1. Geocode first — Pylon requires coordinates AND a non-empty city/zip, and the geocoder's
  //    normalised result lets us backfill a suburb/postcode that's blank in HubSpot.
  const geo = await geocodeSite(c, co)

  // 2. Build the site address, preferring HubSpot data and backfilling from the geocode result.
  // Company name often holds the full site address (e.g. "12 Main St; Suburb; VIC 3000") — take
  // the street part (before first semicolon) for line1. c.address is the contact's *personal*
  // address, not the install site, so it's only a last resort.
  const companyNameStreet = co?.name?.includes(';') ? co.name.split(';')[0].trim() : clean(co?.name)
  const street = clean(c?.install_address) ?? clean(co?.address) ?? companyNameStreet
  const city = clean(c?.city) ?? clean(co?.city) ?? clean(geo?.components.city)
  const state = clean(c?.state) ?? clean(co?.state) ?? clean(geo?.components.state)
  const zip = clean(c?.zip) ?? clean(co?.zip) ?? clean(geo?.components.postcode)
  const country = clean(c?.country) ?? clean(co?.country) ?? 'Australia'

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

  const payload = {
    data: {
      type: 'solar_projects',
      attributes: {
        reference_number: `HS-${deal.id}`,
        is_committed: false,
        site_location: [geo!.lon, geo!.lat] as [number, number],
        customer_details,
        site_address: { line1: street ?? '', line2: '', city, state: state ?? '', zip, country },
      },
    },
  }

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
