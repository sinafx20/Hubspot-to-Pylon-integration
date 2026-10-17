/**
 * Create the deal properties the address check writes to (idempotent: existing ones are left as-is).
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

const PROPERTIES = [
  {
    name: 'address_check',
    label: 'Address check',
    description: 'Result of the automatic address check. Verified = exact match. Check = close, confirm before quoting. Failed = will not be sent to Pylon until fixed.',
    groupName: GROUP.name,
    type: 'enumeration',
    fieldType: 'select',
    displayOrder: 0,
    options: [
      { label: '✅ Verified', value: 'verified', displayOrder: 0 },
      { label: '⚠️ Check', value: 'check', displayOrder: 1 },
      { label: '❌ Failed', value: 'failed', displayOrder: 2 },
    ],
  },
  { ...text('address_check_notes', 'Address check notes', 'Why the address got its grade, in plain English.', 1), fieldType: 'textarea' },
  text('address_check_map', 'Address check map link', 'Google Maps link to where the address was pinned. Open it to confirm the pin is on the right house.', 2),
  text('pylon_address_line1', 'Pylon address: street', 'Street number and name sent to Pylon, e.g. "43 Bassetts Road". Pre-filled by the address check; correct it if wrong.', 3),
  text('pylon_address_unit', 'Pylon address: unit', 'Unit/apartment number only, e.g. "6". Leave blank for a house.', 4),
  text('pylon_address_suburb', 'Pylon address: suburb', 'Suburb sent to Pylon.', 5),
  text('pylon_address_state', 'Pylon address: state', 'State sent to Pylon, e.g. VIC.', 6),
  text('pylon_address_postcode', 'Pylon address: postcode', 'Postcode sent to Pylon. Must belong to the suburb.', 7),
  {
    name: 'pylon_address_recheck',
    label: 'Re-check address (and update Pylon)',
    description: 'Tick after correcting the Pylon address fields. The address is re-checked; if a Pylon project already exists with a wrong address, it is replaced with a corrected one. Unticks itself when done.',
    groupName: GROUP.name,
    type: 'enumeration',
    fieldType: 'booleancheckbox',
    displayOrder: 8,
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
]

async function main() {
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN ===')
  const group = await hs('GET', `/crm/v3/properties/deals/groups/${GROUP.name}`)
  if (group.status === 404) {
    console.log(`group "${GROUP.label}": ${APPLY ? 'creating' : 'would create'}`)
    if (APPLY) {
      const r = await hs('POST', '/crm/v3/properties/deals/groups', GROUP)
      if (r.status >= 300) throw new Error(`group: ${r.status} ${JSON.stringify(r.body)}`)
    }
  } else console.log(`group "${GROUP.label}": exists`)

  for (const p of PROPERTIES) {
    const existing = await hs('GET', `/crm/v3/properties/deals/${p.name}`)
    if (existing.status === 200) {
      console.log(`${p.name}: exists (${existing.body.type}/${existing.body.fieldType}), left as-is`)
      continue
    }
    console.log(`${p.name}: ${APPLY ? 'creating' : 'would create'}`)
    if (APPLY) {
      const r = await hs('POST', '/crm/v3/properties/deals', p)
      if (r.status >= 300) throw new Error(`${p.name}: ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
}

main().catch((e) => {
  console.error('STOPPED:', e.message)
  process.exit(1)
})
