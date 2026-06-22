/**
 * Re-run the HubSpot→Pylon "create solar project" flow for specific deals that previously
 * failed to sync (e.g. older records that hit the empty-city/zip 422 bug).
 *
 * Dry run (default) — geocode + build + validate the Pylon payload and print it, NO writes:
 *   npm run retrigger -- <dealId> [<dealId> ...]
 * Commit — actually create the Pylon project(s), save the link, log the event (idempotent —
 * skips a deal that's already linked to a Pylon project):
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

  const { getDeal, getAssociatedContact, getAssociatedCompany } = await import('../src/services/hubspot')
  const { buildSolarProjectPayload, createSolarProject } = await import('../src/services/pylon')

  for (const dealId of dealIds) {
    console.log(`\n===== Deal ${dealId} =====`)
    try {
      const [deal, contact, company] = await Promise.all([
        getDeal(dealId),
        getAssociatedContact(dealId),
        getAssociatedCompany(dealId),
      ])

      if (commit) {
        const { saveLink, getLinkByDealId } = await import('../src/db/links')
        const existing = await getLinkByDealId(dealId)
        if (existing) {
          console.log(`  Already linked to Pylon project ${existing.pylon_project_id} — skipping`)
          continue
        }
        const project = await createSolarProject(deal, contact, company)
        await saveLink(dealId, project.id)
        console.log(`  ✅ Created Pylon project ${project.id} and saved link`)
      } else {
        const payload = await buildSolarProjectPayload(deal, contact, company)
        const a = payload.data.attributes
        console.log('  DRY RUN — would POST this to Pylon:')
        console.log('    site_location:', a.site_location)
        console.log('    site_address: ', JSON.stringify(a.site_address))
        console.log('    customer:     ', JSON.stringify(a.customer_details))
      }
    } catch (err) {
      console.error(`  ❌ ${(err as Error).message}`)
    }
  }
  process.exit(0)
}

main()
