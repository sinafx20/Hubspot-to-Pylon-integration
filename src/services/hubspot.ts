import { config } from '../config'

const BASE = 'https://api.hubapi.com'

const headers = () => ({
  Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`,
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
    throw new Error(`HubSpot API ${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// All standard + solar-relevant contact properties to pull across to Pylon
const CONTACT_PROPS = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'mobilephone',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'company',
  // Add any custom solar contact properties your client uses, e.g.:
  // 'electricity_bill', 'roof_type', 'property_type'
].join(',')

const DEAL_PROPS = [
  'dealname',
  'amount',
  'description',
  'closedate',
  'dealstage',
  'pipeline',
  // Add any custom solar deal properties your client uses, e.g.:
  // 'system_size_kw', 'number_of_storeys', 'site_address'
].join(',')

export interface HubSpotContact {
  id: string
  properties: {
    firstname?: string
    lastname?: string
    email?: string
    phone?: string
    mobilephone?: string
    address?: string
    city?: string
    state?: string
    zip?: string
    country?: string
    company?: string
    [key: string]: string | undefined
  }
}

export interface HubSpotDeal {
  id: string
  properties: {
    dealname?: string
    amount?: string
    description?: string
    closedate?: string
    dealstage?: string
    pipeline?: string
    [key: string]: string | undefined
  }
}

export async function getDeal(dealId: string): Promise<HubSpotDeal> {
  return request<HubSpotDeal>('GET', `/crm/v3/objects/deals/${dealId}?properties=${DEAL_PROPS}`)
}

export async function getAssociatedContact(dealId: string): Promise<HubSpotContact | null> {
  const assoc = await request<{ results: { id: string }[] }>(
    'GET',
    `/crm/v3/objects/deals/${dealId}/associations/contacts`
  )
  if (!assoc.results.length) return null

  const contactId = assoc.results[0].id
  return request<HubSpotContact>('GET', `/crm/v3/objects/contacts/${contactId}?properties=${CONTACT_PROPS}`)
}

export async function updateDealStage(dealId: string, stageId: string): Promise<void> {
  await request('PATCH', `/crm/v3/objects/deals/${dealId}`, {
    properties: { dealstage: stageId },
  })
}

export async function listPipelines() {
  return request<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>(
    'GET',
    '/crm/v3/pipelines/deals'
  )
}
