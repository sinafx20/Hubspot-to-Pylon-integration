/**
 * Grade the addresses of every deal in the early pipeline stages with the REAL address check
 * (services/address.ts), read-only: nothing is written to HubSpot or Pylon. Shows, per deal, the
 * grade, the standardised address Pylon would get, and why — a quick health check of the CRM.
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
const EARLY_STAGES = ['3224932835', 'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled']

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
  const { getDeal, getAssociatedContact, getAssociatedAccounts } = await import('../src/services/hubspot')
  const { primaryInput, runCheck } = await import('../src/services/address-sync')
  const { formatAddress } = await import('../src/services/address')

  const deals = await searchEarlyDeals()
  console.log(`Checking ${deals.length} early-stage deals.
`)
  const counts = { verified: 0, check: 0, failed: 0 }
  const icon = { verified: '✅', check: '⚠️ ', failed: '❌' }
  for (const d of deals) {
    try {
      const [deal, contact, accounts] = await Promise.all([getDeal(d.id), getAssociatedContact(d.id), getAssociatedAccounts(d.id)])
      const withAddr = accounts.filter((a) => (a.company.properties.install_address ?? '').trim())
      const primary = withAddr.find((a) => a.primary)?.company ?? withAddr[0]?.company ?? null
      const c = await runCheck(primaryInput(deal, primary, contact))
      counts[c.grade]++
      console.log(`${icon[c.grade]} ${(d.name || d.id).slice(0, 24).padEnd(24)} | ${formatAddress(c.fields)}`)
      c.notes.filter((n) => !n.startsWith('Matched with')).forEach((n) => console.log(`     ${n}`))
    } catch (err) {
      console.log(`💥 ${(d.name || d.id).slice(0, 24).padEnd(24)} | ${(err as Error).message.slice(0, 90)}`)
    }
  }
  console.log(`
===== SUMMARY: ✅ ${counts.verified}  ⚠️ ${counts.check}  ❌ ${counts.failed}  (of ${deals.length}) =====`)
  process.exit(0)
}
main()
