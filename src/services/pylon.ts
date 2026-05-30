import { config } from '../config'
import type { HubSpotContact, HubSpotCompany, HubSpotDeal } from './hubspot'

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

  // install_address is a single freeform string — use it as line1.
  // Structured components (state, zip) fall back to company record.
  const address = {
    line1: c.install_address ?? c.address ?? co.address ?? '',
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
  console.log('[pylon] POST /solar_projects payload:', JSON.stringify(payload, null, 2))
  const res = await request<Record<string, unknown>>('POST', '/solar_projects', payload)
  return { id: res.data.id, ...res.data.attributes }
}

export async function getSolarProject(pylonProjectId: string): Promise<PylonProject> {
  const res = await request<Record<string, unknown>>('GET', `/solar_projects/${pylonProjectId}`)
  return { id: res.data.id, ...res.data.attributes }
}
