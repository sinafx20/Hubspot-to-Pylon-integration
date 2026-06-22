/**
 * Audit install_address handling for deals in the early pipeline stages by running each one
 * through the REAL geocode/payload pipeline (buildSolarProjectPayload). Reports, per deal,
 * whether it would produce a valid Pylon project and the resolved suburb/postcode/unit — so we
 * can confirm the single-line address parsing is robust across every entry format in the CRM.
 *
 *   npm run audit:addresses
 */
import fs from 'fs'
import path from 'path'

const envPath = path.join(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key && !key.startsWith('#') && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim()
    }
  }
}

const HS = 'https://api.hubapi.com'
const hsHeaders = { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
const EARLY_STAGES = ['3224932835', 'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function searchEarlyDeals(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = []
  let after: string | undefined
  do {
    const res = await fetch(`${HS}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: hsHeaders,
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'IN', values: EARLY_STAGES }] }],
        properties: ['dealname'],
        limit: 100,
        after,
      }),
    })
    const j: any = await res.json()
    for (const r of j.results ?? []) out.push({ id: r.id, name: r.properties.dealname })
    after = j.paging?.next?.after
  } while (after)
  return out
}

async function main() {
  const { getDeal, getAssociatedContact, getAssociatedCompany } = await import('../src/services/hubspot')
  const { buildSolarProjectPayload } = await import('../src/services/pylon')

  const deals = await searchEarlyDeals()
  console.log(`Auditing ${deals.length} early-stage deals through the real pipeline.\n`)
  let pass = 0
  const fails: string[] = []

  const counts: Record<string, number> = {}
  const realLog = console.log // geocoder logs precision via console.log; capture it per deal
  for (const d of deals) {
    let precision = '?'
    try {
      const [deal, contact, company] = await Promise.all([
        getDeal(d.id),
        getAssociatedContact(d.id),
        getAssociatedCompany(d.id),
      ])
      console.log = (...args: unknown[]) => {
        const m = String(args[0]).match(/Geocoded \((\w+)\)/)
        if (m) precision = m[1]
      }
      const a = (await buildSolarProjectPayload(deal, contact, company)).data.attributes
      console.log = realLog
      counts[precision] = (counts[precision] ?? 0) + 1
      const sa: any = a.site_address
      const unit = sa.line2 ? ` [${sa.line2}]` : ''
      const mark = precision === 'rooftop' ? '🎯' : precision === 'street' ? '🛣 ' : '📍'
      console.log(`${mark} ${precision.padEnd(7)} ${(d.name || d.id).slice(0, 24).padEnd(24)} | "${sa.line1}" → ${sa.city} ${sa.zip}${unit}`)
      pass++
    } catch (err) {
      console.log = realLog
      const msg = (err as Error).message.replace(/\s+/g, ' ').slice(0, 90)
      console.log(`❌ ${(d.name || d.id).slice(0, 28).padEnd(28)} → ${msg}`)
      fails.push(`  "${d.name}" (deal ${d.id}): ${msg}`)
    }
    await sleep(1200) // Nominatim ~1 req/s (each deal may make a few lookups)
  }

  console.log(`\n===== SUMMARY: ${pass}/${deals.length} would sync =====`)
  console.log('  pin precision:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '))
  if (fails.length) {
    console.log('Need attention (data entry — no fixable address):')
    fails.forEach((f) => console.log(f))
  }
  process.exit(0)
}
main()
