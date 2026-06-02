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
  'install_address',
  'address',
  'city',
  'state',
  'zip',
  'country',
  'company',
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
    install_address?: string
    address?: string
    city?: string
    state?: string
    zip?: string
    country?: string
    company?: string
    [key: string]: string | undefined
  }
}

export interface HubSpotCompany {
  id: string
  properties: {
    name?: string
    address?: string
    city?: string
    state?: string
    zip?: string
    country?: string
    phone?: string
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

const COMPANY_PROPS = ['name', 'address', 'city', 'state', 'zip', 'country', 'phone'].join(',')

export async function getAssociatedCompany(dealId: string): Promise<HubSpotCompany | null> {
  const assoc = await request<{ results: { id: string }[] }>(
    'GET',
    `/crm/v3/objects/deals/${dealId}/associations/companies`
  )
  if (!assoc.results.length) return null

  const companyId = assoc.results[0].id
  return request<HubSpotCompany>('GET', `/crm/v3/objects/companies/${companyId}?properties=${COMPANY_PROPS}`)
}

export async function updateDealStage(dealId: string, stageId: string): Promise<void> {
  await request('PATCH', `/crm/v3/objects/deals/${dealId}`, {
    properties: { dealstage: stageId },
  })
}

export async function updateDealProperties(
  dealId: string,
  properties: Record<string, string | number>
): Promise<void> {
  await request('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties })
}

// Cache enum option values per process so we only fetch each dropdown's options once.
const _optionCache = new Map<string, string[]>()

/** Valid option values for an enumeration (dropdown) property, e.g. the allowed panel brands. */
export async function getEnumOptionValues(objectType: string, propertyName: string): Promise<string[]> {
  const key = `${objectType}.${propertyName}`
  const cached = _optionCache.get(key)
  if (cached) return cached
  const def = await request<{ options?: { value: string }[] }>(
    'GET',
    `/crm/v3/properties/${objectType}/${propertyName}`
  )
  const values = (def.options ?? []).map((o) => o.value)
  _optionCache.set(key, values)
  return values
}

// fetch + DELETE/PUT helpers that tolerate empty (204) responses
async function requestVoid(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HubSpot API ${method} ${path} → ${res.status}: ${text}`)
  }
}

// Associate two existing objects using HubSpot's default (HUBSPOT_DEFINED) association type,
// so we never have to hardcode numeric association type IDs.
// Retries transient HubSpot errors (5xx / 429) — these association calls intermittently
// return a 500 INTERNAL_ERROR that succeeds on retry.
async function associateDefault(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string
): Promise<void> {
  const path = `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await requestVoid('PUT', path)
      return
    } catch (err) {
      const msg = (err as Error).message
      const transient = /→ (5\d\d|429):/.test(msg) // e.g. "... → 500: ..."
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 600))
        continue
      }
      throw err
    }
  }
}

export interface DealLineItem {
  name: string
  quantity: number
  price: number // unit price in dollars
}

/**
 * Replace ALL line items currently associated with a deal with a fresh set.
 * Existing line items are archived (deleted), then the new ones are created and associated.
 */
export async function overwriteDealLineItems(dealId: string, items: DealLineItem[]): Promise<void> {
  // 1. Find existing line items on the deal
  const assoc = await request<{ results: { id: string; toObjectId?: string }[] }>(
    'GET',
    `/crm/v3/objects/deals/${dealId}/associations/line_items`
  )

  // 2. Archive them
  for (const r of assoc.results) {
    const lineItemId = r.toObjectId ?? r.id
    await requestVoid('DELETE', `/crm/v3/objects/line_items/${lineItemId}`)
  }
  console.log(`[hubspot] Removed ${assoc.results.length} existing line item(s) from deal ${dealId}`)

  // 3. Create the new line items and associate each to the deal
  for (const item of items) {
    const created = await request<{ id: string }>('POST', `/crm/v3/objects/line_items`, {
      properties: {
        name: item.name,
        quantity: String(item.quantity),
        price: String(item.price),
      },
    })
    await associateDefault('deals', dealId, 'line_items', created.id)
  }
  console.log(`[hubspot] Created ${items.length} new line item(s) on deal ${dealId}`)
}

/**
 * Create a Note (timeline activity) and associate it to the deal, contact, and company.
 * hs_note_body accepts simple HTML.
 */
export async function createNote(
  body: string,
  associations: { dealId?: string; contactId?: string; companyId?: string }
): Promise<void> {
  const note = await request<{ id: string }>('POST', `/crm/v3/objects/notes`, {
    properties: {
      hs_note_body: body,
      hs_timestamp: new Date().toISOString(),
    },
  })

  // Associate to each target independently: a failure on one (e.g. a persistent HubSpot
  // error) must not orphan the note or block the other associations.
  const targets: [string, string | undefined][] = [
    ['deals', associations.dealId],
    ['contacts', associations.contactId],
    ['companies', associations.companyId],
  ]
  const failed: string[] = []
  for (const [type, id] of targets) {
    if (!id) continue
    try {
      await associateDefault('notes', note.id, type, id)
    } catch (err) {
      failed.push(`${type} ${id}`)
      console.error(`[hubspot] Note ${note.id} could not associate to ${type} ${id}: ${(err as Error).message}`)
    }
  }
  if (failed.length) {
    console.warn(`[hubspot] Note ${note.id} created but not linked to: ${failed.join(', ')}`)
  } else {
    console.log(`[hubspot] Created note ${note.id} on deal=${associations.dealId} contact=${associations.contactId} company=${associations.companyId}`)
  }
}

export async function listPipelines() {
  return request<{ results: { id: string; label: string; stages: { id: string; label: string }[] }[] }>(
    'GET',
    '/crm/v3/pipelines/deals'
  )
}
