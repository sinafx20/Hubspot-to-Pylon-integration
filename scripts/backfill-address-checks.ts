/**
 * Fill the address check on the accounts (properties) of every open deal, and refresh each deal's
 * "Pylon sites" summary. A deal whose accounts all lack an install address gets the contact's
 * copied onto its account first (as the integration now does for new deals). Accounts that already have a check are left alone, so it's safe to re-run.
 * Never touches Pylon, install addresses or deal stages. Before writing, saves each account's
 * current name to backfill-names.local.json so the renames can be undone.
 *
 *   npx tsx scripts/backfill-address-checks.ts            (dry run: grades only, no writes)
 *   npx tsx scripts/backfill-address-checks.ts --apply
 *   npx tsx scripts/backfill-address-checks.ts --regrade [--apply]   also re-check unconfirmed ⚠️/❌
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
// The services read the full app config; only the HubSpot token matters for this script.
for (const k of ['DATABASE_URL', 'REDIS_URL', 'HUBSPOT_CLIENT_SECRET', 'HUBSPOT_STAGE_READY_TO_QUOTE', 'HUBSPOT_STAGE_QUOTE_SENT', 'HUBSPOT_STAGE_CLOSED_WON', 'PYLON_API_TOKEN']) {
  process.env[k] ??= 'unused-by-backfill'
}
process.env.HUBSPOT_PIPELINE_ID ??= 'default'

const APPLY = process.argv.includes('--apply')
// Re-check accounts graded ⚠️/❌ that staff haven't confirmed (e.g. after adding the Google key).
const REGRADE = process.argv.includes('--regrade')
const OPEN_STAGES = ['3224932835', 'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', '3966894582', 'contractsent']

async function main() {
  const hs = await import('../src/services/hubspot')
  const sync = await import('../src/services/address-sync')
  const { formatAddress } = await import('../src/services/address')
  const token = process.env.HUBSPOT_ACCESS_TOKEN

  const deals: { id: string; name: string }[] = []
  let after: string | undefined
  do {
    const r: any = await (
      await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'IN', values: OPEN_STAGES }] }], properties: ['dealname'], limit: 100, after }),
      })
    ).json()
    deals.push(...r.results.map((d: any) => ({ id: d.id, name: (d.properties.dealname ?? '').trim() })))
    after = r.paging?.next?.after
  } while (after)
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${deals.length} open deals\n`)

  const namesPath = path.join(__dirname, '../backfill-names.local.json')
  const oldNames: Record<string, string> = fs.existsSync(namesPath) ? JSON.parse(fs.readFileSync(namesPath, 'utf-8')) : {}
  const counts = { verified: 0, check: 0, failed: 0, skipped: 0, contactOnly: 0, filledFromContact: 0, errors: 0 }
  const moves: Record<string, number> = {}
  const done = new Set<string>()

  for (const d of deals) {
    try {
      const [accounts, contact] = await Promise.all([hs.getAssociatedAccounts(d.id), hs.getAssociatedContact(d.id)])
      if (!accounts.some((a) => sync.isSite(a.company)) && contact?.properties.install_address?.trim()) {
        counts.filledFromContact++
        if (APPLY) await sync.fillEmptyAccountFromContact(accounts, contact)
        else console.log(`↪  ${d.name.slice(0, 22).padEnd(22)} would copy the contact's "${contact.properties.install_address}" onto its empty account`)
      }
      const sites = accounts.filter((a) => sync.isSite(a.company))
      if (!sites.length) counts.contactOnly++
      for (const { company } of sites) {
        if (done.has(company.id)) continue
        done.add(company.id)
        const p = company.properties
        const before = p.address_check ?? 'none'
        const confirmed = (p.address_check_notes ?? '').includes('Confirmed on re-check')
        const regrade = REGRADE && (before === 'check' || before === 'failed') && !confirmed
        if (sync.accountHasFields(company) && !regrade) {
          counts.skipped++
          continue
        }
        // Re-check from the raw install address, unless a person edited the Pylon fields by hand.
        let input = sync.rawInput(company, sync.contactForAccount(company, [contact]))
        if (regrade) {
          const h: any = await (
            await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${company.id}?propertiesWithHistory=pylon_address_line1,pylon_address_suburb,pylon_address_postcode`, {
              headers: { Authorization: `Bearer ${token}` },
            })
          ).json()
          const byHand = Object.values(h.propertiesWithHistory ?? {}).some((hist: any) => hist[0]?.sourceType === 'CRM_UI')
          if (byHand) input = sync.accountInput(company, sync.contactForAccount(company, [contact]))
        }
        const check = await sync.runCheck(input)
        counts[check.grade]++
        if (regrade) moves[`${before} → ${check.grade}`] = (moves[`${before} → ${check.grade}`] ?? 0) + 1
        const mark = { verified: '✅', check: '⚠️ ', failed: '❌' }[check.grade]
        console.log(`${mark} ${d.name.slice(0, 22).padEnd(22)} ${(company.properties.install_address ?? '').slice(0, 40).padEnd(40)} → ${formatAddress(check.fields)}`)
        if (APPLY) {
          oldNames[company.id] ??= company.properties.name ?? ''
          fs.writeFileSync(namesPath, JSON.stringify(oldNames, null, 1))
          await sync.writeCheckToAccount(company, check)
        }
      }
      if (APPLY) await sync.refreshDealSummary(d.id)
    } catch (err) {
      counts.errors++
      console.log(`💥 deal ${d.id} ${d.name}: ${(err as Error).message.slice(0, 120)}`)
    }
  }
  console.log(`\n${JSON.stringify(counts)}`)
  if (REGRADE) console.log(`re-graded: ${JSON.stringify(moves)}`)
  if (APPLY) console.log(`Old account names saved to ${path.basename(namesPath)}`)
  process.exit(0)
}

main()
