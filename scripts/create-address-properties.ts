/**
 * Create the account and deal properties the address check writes to (idempotent), and remove the
 * superseded deal-level address fields.
 *
 *   npx tsx scripts/create-address-properties.ts          (dry run: shows what's missing)
 *   npx tsx scripts/create-address-properties.ts --apply
 */
import fs from 'fs'
import path from 'path'

const envPath = path.join(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key && !key.startsWith('#') && rest.length && !process.env[key.trim()]) process.env[key.trim()] = rest.join('=').trim()
  }
}
const token = process.env.HUBSPOT_ACCESS_TOKEN
if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN not set')
const APPLY = process.argv.includes('--apply')

async function hs(method: string, url: string, body?: unknown) {
  const res = await fetch(`https://api.hubapi.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  // Some 404s (e.g. a missing property group) come back as an HTML page, not JSON.
  const raw = await res.text()
  let parsed: any = {}
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = { raw: raw.slice(0, 200) }
  }
  return { status: res.status, body: parsed }
}

const GROUP = { name: 'pylon_address', label: 'Pylon address', displayOrder: -1 }

const text = (name: string, label: string, description: string, displayOrder: number) => ({
  name, label, description, groupName: GROUP.name, type: 'string', fieldType: 'text', displayOrder,
})
const checkbox = (name: string, label: string, description: string, displayOrder: number) => ({
  name, label, description, groupName: GROUP.name, type: 'enumeration', fieldType: 'booleancheckbox', displayOrder,
  options: [
    { label: 'Yes', value: 'true', displayOrder: 0 },
    { label: 'No', value: 'false', displayOrder: 1 },
  ],
})
const grade = (description: string) => ({
  name: 'address_check', label: 'Address check', description, groupName: GROUP.name, type: 'enumeration', fieldType: 'select', displayOrder: 0,
  options: [
    { label: '✅ Verified', value: 'verified', displayOrder: 0 },
    { label: '⚠️ Check', value: 'check', displayOrder: 1 },
    { label: '❌ Failed', value: 'failed', displayOrder: 2 },
  ],
})

// The account (company) is the source of truth: one account = one property = one Pylon project.
const COMPANY_PROPERTIES = [
  grade('Result of the automatic check of this property’s address. Verified = exact match. Check = close, confirm it. Failed = will not be sent to Pylon until fixed.'),
  { ...text('address_check_notes', 'Address check notes', 'Why the address got its grade, in plain English.', 1), fieldType: 'textarea' },
  text('address_check_map', 'Address check map link', 'Google Maps link to where the address was pinned. Open it to confirm the pin is on the right house.', 2),
  text('pylon_address_line1', 'Pylon address: street', 'Street number and name sent to Pylon, e.g. "43 Bassetts Road". Pre-filled by the address check; correct it if wrong, then tick Re-check address.', 3),
  text('pylon_address_unit', 'Pylon address: unit', 'Unit/apartment number only, e.g. "6". Leave blank for a house.', 4),
  text('pylon_address_suburb', 'Pylon address: suburb', 'Suburb sent to Pylon.', 5),
  text('pylon_address_state', 'Pylon address: state', 'State sent to Pylon, e.g. VIC.', 6),
  text('pylon_address_postcode', 'Pylon address: postcode', 'Postcode sent to Pylon. Must belong to the suburb.', 7),
  checkbox('pylon_address_recheck', 'Re-check address (and update Pylon)', 'Tick after correcting the Pylon address fields. The address is re-checked; if a Pylon project already exists for this property with a wrong address, it is replaced with a corrected one. Unticks itself when done.', 8),
]

// The deal shows a read-only summary of all its properties, plus the confirmation staff tick in
// the Ready to quote pop-up (make it a required stage property in HubSpot).
const DEAL_PROPERTIES = [
  grade('Worst address check across this deal’s properties. Fix flagged properties on their account before Ready to quote.'),
  { ...text('pylon_sites', 'Pylon sites', 'One line per property on this deal, with its address check result. Updated automatically; fix addresses on the account, not here.', 1), fieldType: 'textarea' },
  checkbox('pylon_addresses_confirmed', 'Pylon addresses confirmed', 'Tick once you have checked every property in Pylon sites is the right address. Required to move to Ready to quote.', 2),
]

// Deal-level address fields from the first design, superseded by the account-level ones.
const DEAL_OBSOLETE = [
  'address_check_notes', 'address_check_map', 'pylon_address_line1', 'pylon_address_unit',
  'pylon_address_suburb', 'pylon_address_state', 'pylon_address_postcode', 'pylon_address_recheck',
]

async function ensure(object: 'companies' | 'deals', properties: any[]) {
  const group = await hs('GET', `/crm/v3/properties/${object}/groups/${GROUP.name}`)
  if (group.status === 404) {
    console.log(`${object} group "${GROUP.label}": ${APPLY ? 'creating' : 'would create'}`)
    if (APPLY) {
      const r = await hs('POST', `/crm/v3/properties/${object}/groups`, GROUP)
      if (r.status >= 300) throw new Error(`group: ${r.status} ${JSON.stringify(r.body)}`)
    }
  } else console.log(`${object} group "${GROUP.label}": exists`)

  for (const p of properties) {
    const existing = await hs('GET', `/crm/v3/properties/${object}/${p.name}`)
    if (existing.status === 200) {
      // Keep the definition current (labels/descriptions), never change the type.
      const { name, type, fieldType, ...editable } = p
      console.log(`${object}.${p.name}: exists, ${APPLY ? 'updating label/description' : 'would update label/description'}`)
      if (APPLY) {
        const r = await hs('PATCH', `/crm/v3/properties/${object}/${p.name}`, editable)
        if (r.status >= 300) throw new Error(`${p.name}: ${r.status} ${JSON.stringify(r.body)}`)
      }
      continue
    }
    console.log(`${object}.${p.name}: ${APPLY ? 'creating' : 'would create'}`)
    if (APPLY) {
      const r = await hs('POST', `/crm/v3/properties/${object}`, p)
      if (r.status >= 300) throw new Error(`${p.name}: ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
}

async function main() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN ===')
  await ensure('companies', COMPANY_PROPERTIES)
  await ensure('deals', DEAL_PROPERTIES)
  for (const name of DEAL_OBSOLETE) {
    const existing = await hs('GET', `/crm/v3/properties/deals/${name}`)
    if (existing.status !== 200) continue
    console.log(`deals.${name}: obsolete, ${APPLY ? 'deleting' : 'would delete'}`)
    if (APPLY) {
      const r = await hs('DELETE', `/crm/v3/properties/deals/${name}`)
      if (r.status >= 300) throw new Error(`delete ${name}: ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
}

main().catch((e) => {
  console.error('STOPPED:', e.message)
  process.exit(1)
})
