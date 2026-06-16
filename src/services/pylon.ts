import { config } from '../config'
import type { HubSpotContact, HubSpotCompany, HubSpotDeal } from './hubspot'
import { geocodeAddress, searchCandidates } from './geocode'

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

function buildProjectPayload(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  company: HubSpotCompany | null
) {
  const p = deal.properties
  const c = contact?.properties ?? {}
  const co = company?.properties ?? {}

  const firstName = c.firstname ?? ''
  const lastName = c.lastname ?? ''
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || undefined

  // Company name often holds the full site address (e.g. "12 Main St; Suburb; VIC 3000")
  // Extract just the street part (before first semicolon) for line1
  const companyNameStreet = co.name?.includes(';') ? co.name.split(';')[0].trim() : co.name ?? null

  // NOTE: c.address is the contact's personal address, NOT the install site — skip it for line1
  const address = {
    line1: c.install_address ?? co.address ?? companyNameStreet ?? '',
    line2: '',
    city: c.city ?? co.city ?? '',
    state: c.state ?? co.state ?? '',
    zip: c.zip ?? co.zip ?? '',
    country: c.country ?? co.country ?? 'Australia',
  }

  return {
    data: {
      type: 'solar_projects',
      attributes: {
        reference_number: `HS-${deal.id}`,
        is_committed: false,
        site_location: null as [number, number] | null,
        customer_details: {
          name: fullName,
          email: c.email,
          phone: c.phone ?? c.mobilephone,
        },
        site_address: address,
      },
    },
  }
}

export async function createSolarProject(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  company: HubSpotCompany | null
): Promise<PylonProject> {
  const payload = buildProjectPayload(deal, contact, company)

  // Geocode to get coordinates (required by Pylon).
  // Structured geocoding (street/suburb/state/postcode as separate fields) is much more
  // robust than a free-text blob and self-recovers from a messy street by falling back
  // to the suburb centroid — see searchCandidates().
  const c = contact?.properties
  const co = company?.properties
  const structured = await searchCandidates({
    parts: {
      street: c?.install_address ?? co?.address ?? undefined,
      city: c?.city ?? co?.city ?? undefined,
      state: c?.state ?? co?.state ?? undefined,
      postcode: c?.zip ?? co?.zip ?? undefined,
    },
  })
  if (structured.length) {
    payload.data.attributes.site_location = [structured[0].lon, structured[0].lat]
    console.log(`[pylon] Geocoded (${structured[0].precision}) "${structured[0].display}"`)
  } else {
    // Fall back to free-text candidates (e.g. company name often holds the full site address).
    const freeCandidates = [
      c?.install_address,
      co?.name,
      c?.address,
      co?.address,
    ].filter(Boolean) as string[]
    for (const candidate of freeCandidates) {
      const coords = await geocodeAddress(candidate)
      if (coords) {
        payload.data.attributes.site_location = coords
        console.log(`[pylon] Geocoded (free-text) "${candidate}" → [${coords}]`)
        break
      }
    }
  }

  if (!payload.data.attributes.site_location) {
    console.warn(`[pylon] Could not geocode any address for deal ${deal.id} — Pylon will reject`)
  }

  // Avoid logging the full payload — it contains customer PII (name, email, address).
  console.log(`[pylon] Creating solar project for deal ${deal.id} (geocoded=${!!payload.data.attributes.site_location})`)
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
