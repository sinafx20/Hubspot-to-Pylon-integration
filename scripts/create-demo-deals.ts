/**
 * Create 5 demo deals in the "Site Assessed" stage, each with a different install_address
 * one-liner format, for manually testing the HubSpot→Pylon sync (move them to "Ready to quote").
 * Only install_address is set on the contact (no structured city/state/zip) — that's the field
 * that matters. Deals/contacts are clearly prefixed "DEMO" for easy cleanup.
 *
 *   npm run demo:create
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

const HS = 'https://api.hubapi.com'
const headers = { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
const SITE_ASSESSED = 'decisionmakerboughtin'

const DEMOS = [
  { last: 'One',   deal: 'DEMO 1 — Unit word, flat-land',     install: 'Unit 2 1 Rodleigh St Croydon Victoria 3136' },
  { last: 'Two',   deal: 'DEMO 2 — Unit slash',               install: '3/20 Valerie Street, Templestowe Lower VIC 3107' },
  { last: 'Three', deal: 'DEMO 3 — U-format, no postcode',    install: 'U5 9 Azalea Way Rockbank VIC' },
  { last: 'Four',  deal: 'DEMO 4 — Messy lowercase, no pc',   install: '36 sheila st preston' },
  { last: 'Five',  deal: 'DEMO 5 — Clean, no unit',           install: '208 Stephensons Road, Mount Waverley VIC 3149' },
]

async function post(pathname: string, body: unknown) {
  const res = await fetch(`${HS}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const j: any = await res.json()
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${JSON.stringify(j)}`)
  return j
}

async function main() {
  for (const d of DEMOS) {
    const contact = await post('/crm/v3/objects/contacts', {
      properties: { firstname: 'Demo', lastname: d.last, phone: '+61400000000', email: `demo.${d.last.toLowerCase()}@example.com`, install_address: d.install },
    })
    const deal = await post('/crm/v3/objects/deals', {
      properties: { dealname: d.deal, pipeline: 'default', dealstage: SITE_ASSESSED },
    })
    // associate deal → contact (default association type)
    const assoc = await fetch(`${HS}/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contact.id}`, { method: 'PUT', headers })
    if (!assoc.ok) throw new Error(`associate ${deal.id}→${contact.id} → ${assoc.status}: ${await assoc.text()}`)
    console.log(`✅ deal ${deal.id}  "${d.deal}"  | contact ${contact.id}  | install="${d.install}"`)
  }
  console.log('\nAll 5 created in "Site Assessed". Move each to "Ready to quote" to trigger the Pylon sync.')
  process.exit(0)
}
main()
