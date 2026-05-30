/**
 * Verifies that deal + contact + company data can be fetched from HubSpot.
 * Usage: npm run hs:test-fetch <dealId>
 * Example: npm run hs:test-fetch 12345
 */

import fs from 'fs'
import path from 'path'

const envPath = path.join(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key && !key.startsWith('#') && rest.length) {
      process.env[key.trim()] = rest.join('=').trim()
    }
  }
}

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN
if (!TOKEN) {
  console.error('HUBSPOT_ACCESS_TOKEN not set in .env')
  process.exit(1)
}

const dealId = process.argv[2]
if (!dealId) {
  console.error('Usage: npm run hs:test-fetch <dealId>')
  process.exit(1)
}

const BASE = 'https://api.hubapi.com'
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as T
}

const DEAL_PROPS = 'dealname,amount,description,closedate,dealstage,pipeline'
const CONTACT_PROPS = 'firstname,lastname,email,phone,mobilephone,install_address,address,city,state,zip,country,company'
const COMPANY_PROPS = 'name,address,city,state,zip,country,phone'

async function main() {
  const deal = await get<any>(`/crm/v3/objects/deals/${dealId}?properties=${DEAL_PROPS}`)
  console.log('\n=== DEAL ===')
  console.log(JSON.stringify(deal.properties, null, 2))

  const contactAssoc = await get<any>(`/crm/v3/objects/deals/${dealId}/associations/contacts`)
  if (contactAssoc.results.length) {
    const contact = await get<any>(`/crm/v3/objects/contacts/${contactAssoc.results[0].id}?properties=${CONTACT_PROPS}`)
    console.log('\n=== CONTACT ===')
    console.log(JSON.stringify(contact.properties, null, 2))
  } else {
    console.log('\n=== CONTACT === (none associated)')
  }

  const companyAssoc = await get<any>(`/crm/v3/objects/deals/${dealId}/associations/companies`)
  if (companyAssoc.results.length) {
    const company = await get<any>(`/crm/v3/objects/companies/${companyAssoc.results[0].id}?properties=${COMPANY_PROPS}`)
    console.log('\n=== COMPANY ===')
    console.log(JSON.stringify(company.properties, null, 2))
  } else {
    console.log('\n=== COMPANY === (none associated)')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
