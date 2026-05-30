import { config } from '../config'
import type { HubSpotContact, HubSpotDeal } from './hubspot'

const BASE = 'https://api.getpylon.com'

const headers = () => ({
  Authorization: `Bearer ${config.PYLON_API_TOKEN}`,
  'Content-Type': 'application/json',
})

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Pylon API ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export interface PylonProject {
  id: string
  [key: string]: unknown
}

/**
 * Builds the payload for creating a Pylon solar project from HubSpot data.
 *
 * IMPORTANT: Verify all field names against your Pylon API docs before going live.
 * The structure below is based on the REST resources listed in the Pylon API reference.
 * Adjust property names to match what Pylon's POST /solar_projects endpoint expects.
 */
function buildProjectPayload(deal: HubSpotDeal, contact: HubSpotContact | null) {
  const p = deal.properties
  const c = contact?.properties ?? {}

  return {
    // Project-level fields — verify these names against Pylon docs
    name: p.dealname ?? 'Untitled Project',
    notes: p.description ?? '',

    // Contact/customer details passed in so designers don't need to re-enter them
    // Verify the nested key names Pylon expects (e.g. "contact" vs "customer" vs flat fields)
    contact: {
      first_name: c.firstname ?? '',
      last_name: c.lastname ?? '',
      email: c.email ?? '',
      phone: c.phone ?? c.mobilephone ?? '',
      company: c.company ?? '',
    },

    // Site/install address — if your client captures a separate site address in HS
    // as a custom property, replace these with the correct property names
    site_address: {
      street: c.address ?? '',
      city: c.city ?? '',
      state: c.state ?? '',
      postcode: c.zip ?? '',
      country: c.country ?? 'Australia',
    },

    // Financial reference from HS deal — useful for designer context
    // Remove or rename if Pylon doesn't have an equivalent field
    estimated_value: p.amount ? parseFloat(p.amount) : undefined,

    // Pass the HubSpot deal ID as an external reference so you can always
    // trace a Pylon project back to its origin deal
    external_reference: deal.id,
  }
}

export async function createSolarProject(
  deal: HubSpotDeal,
  contact: HubSpotContact | null
): Promise<PylonProject> {
  const payload = buildProjectPayload(deal, contact)
  return request<PylonProject>('POST', '/solar_projects', payload)
}

export async function getSolarProject(pylonProjectId: string): Promise<PylonProject> {
  return request<PylonProject>('GET', `/solar_projects/${pylonProjectId}`)
}
