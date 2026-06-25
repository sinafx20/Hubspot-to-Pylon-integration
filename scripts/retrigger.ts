/**
 * Re-run the HubSpot→Pylon "create solar project" flow for specific deals. Now per-account: each
 * associated Account (property) with an install_address becomes its own Pylon project (the
 * HubSpot-primary account anchors the deal). Falls back to a contact-based project if no account
 * has an address.
 *
 * Dry run (default) — geocode + build + validate each account's payload, NO writes:
 *   npm run retrigger -- <dealId> [<dealId> ...]
 * Commit — run the real (idempotent) sync job: create any missing projects + save links:
 *   npm run retrigger -- --commit <dealId> [<dealId> ...]
 */
import fs from 'fs'
import path from 'path'

const envPath = path.join(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=')
    // Don't override vars already in the environment (e.g. injected by `railway run`).
    if (key && !key.startsWith('#') && rest.length && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join('=').trim()
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const dealIds = args.filter((a) => !a.startsWith('--'))

  if (!dealIds.length) {
    console.error('Usage: npm run retrigger -- [--commit] <dealId> [<dealId> ...]')
    process.exit(1)
  }

  const { getDeal, getAssociatedContact, getAssociatedAccounts } = await import('../src/services/hubspot')
  const { buildSolarProjectPayload } = await import('../src/services/pylon')

  for (const dealId of dealIds) {
    console.log(`\n===== Deal ${dealId} =====`)
    try {
      if (commit) {
        const { handleCreatePylonProject } = await import('../src/jobs/create-pylon-project')
        await handleCreatePylonProject({ dealId, eventId: `manual-${dealId}-${Date.now()}` })
        console.log('  ✅ sync run complete (see [create-pylon-project] log lines above)')
      } else {
        const [deal, contact, accounts] = await Promise.all([
          getDeal(dealId),
          getAssociatedContact(dealId),
          getAssociatedAccounts(dealId),
        ])
        const withAddr = accounts.filter((a) => (a.company.properties.install_address ?? '').trim())
        const targets = withAddr.length
          ? withAddr.map((a) => ({ account: a.company, primary: a.primary }))
          : [{ account: null as null, primary: true }]
        console.log(`  ${accounts.length} account(s), ${withAddr.length} with an install address`)
        for (const t of targets) {
          try {
            const a = (await buildSolarProjectPayload(deal, contact, t.account, { borrowContactPostcode: t.primary || targets.length === 1 })).data.attributes as any
            console.log(`  ${t.primary ? '[PRIMARY]  ' : '[secondary]'} account ${t.account?.id ?? 'contact'}:`)
            console.log(`     line1="${a.site_address.line1}" line2="${a.site_address.line2}" ${a.site_address.city} ${a.site_address.zip}  pin=${JSON.stringify(a.site_location)}`)
          } catch (e) {
            console.log(`  ${t.primary ? '[PRIMARY]  ' : '[secondary]'} account ${t.account?.id ?? 'contact'}: ❌ ${(e as Error).message}`)
          }
        }
      }
    } catch (err) {
      console.error(`  ❌ ${(err as Error).message}`)
    }
  }
  process.exit(0)
}

main()
