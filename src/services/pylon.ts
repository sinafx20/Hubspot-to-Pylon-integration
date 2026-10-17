import { UnrecoverableError } from 'bullmq'
import { config } from '../config'
import type { HubSpotContact, HubSpotCompany, HubSpotDeal } from './hubspot'
import type { AddressCheck } from './address'

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

export const referenceFor = (deal: HubSpotDeal, account: HubSpotCompany | null) =>
  account ? `HS-${deal.id}-${account.id}` : `HS-${deal.id}`

/**
 * Build the Pylon solar_projects payload from a deal's address check (see services/address.ts).
 * The address and pin come only from the check's standardised result; a failed check never
 * reaches Pylon. Separated from the POST so it can be dry-run without writing to Pylon.
 */
export function buildSolarProjectPayload(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  account: HubSpotCompany | null,
  check: AddressCheck,
  reference = referenceFor(deal, account)
) {
  if (check.grade === 'failed' || !check.match) {
    // Can never succeed on retry: fail fast and non-retryably so it lands on the dashboard.
    throw new UnrecoverableError(
      `Address check failed for deal ${deal.id}${account ? ` (account ${account.id})` : ''}: ` +
        `${check.notes.filter((n) => n.startsWith('❌')).join(' ')} ` +
        `Fix the Pylon address fields on the deal, then tick "Re-check address" or click Retry.`
    )
  }
  const c = contact?.properties
  const f = check.fields

  // Customer details: only fields we have. Pylon rejects an explicit null, so omit empties.
  const customer_details: { name?: string; email?: string; phone?: string } = {}
  const name = [clean(c?.firstname), clean(c?.lastname)].filter(Boolean).join(' ')
  if (name) customer_details.name = name
  const email = clean(c?.email)
  if (email) customer_details.email = email
  const phone = clean(c?.phone) ?? clean(c?.mobilephone)
  if (phone) customer_details.phone = phone

  return {
    data: {
      type: 'solar_projects',
      attributes: {
        reference_number: reference,
        is_committed: false,
        site_location: [check.match.lon, check.match.lat] as [number, number],
        customer_details,
        site_address: {
          line1: f.line1,
          line2: f.unit ? `Unit ${f.unit}` : '',
          city: f.suburb,
          state: f.state,
          zip: f.postcode,
          country: 'Australia',
        },
      },
    },
  }
}

export async function createSolarProject(
  deal: HubSpotDeal,
  contact: HubSpotContact | null,
  account: HubSpotCompany | null,
  check: AddressCheck,
  reference?: string
): Promise<PylonProject> {
  const payload = buildSolarProjectPayload(deal, contact, account, check, reference)

  // Avoid logging the full payload — it contains customer PII (name, email, address).
  console.log(`[pylon] Creating solar project for deal ${deal.id} (address ${check.grade}, ${check.match?.provider})`)
  const res = await request<Record<string, unknown>>('POST', '/solar_projects', payload)
  return { id: res.data.id, ...res.data.attributes }
}

export async function getSolarProject(pylonProjectId: string): Promise<PylonProject> {
  const res = await request<Record<string, unknown>>('GET', `/solar_projects/${pylonProjectId}`)
  return { id: res.data.id, ...res.data.attributes }
}

/**
 * Archive a project that was created with a wrong address. Pylon can't change a project's address
 * or pin through the API, so a correction means archiving the old project and creating a new one.
 */
export async function archiveSolarProject(pylonProjectId: string, reference: string): Promise<void> {
  await request('PATCH', `/solar_projects/${pylonProjectId}`, {
    data: { type: 'solar_projects', id: pylonProjectId, attributes: { is_archived: true, reference_number: reference } },
  })
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
