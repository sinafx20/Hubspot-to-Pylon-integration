/**
 * Run this once to print all your HubSpot pipeline and stage IDs.
 * Copy the IDs you need into your .env file.
 *
 * Usage: npm run hs:stages
 */

// Load env manually for script context
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

const token = process.env.HUBSPOT_ACCESS_TOKEN
if (!token) {
  console.error('HUBSPOT_ACCESS_TOKEN not set in .env')
  process.exit(1)
}

const res = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
  headers: { Authorization: `Bearer ${token}` },
})

if (!res.ok) {
  console.error('HubSpot API error:', res.status, await res.text())
  process.exit(1)
}

const data = await res.json() as {
  results: { id: string; label: string; stages: { id: string; label: string; displayOrder: number }[] }[]
}

for (const pipeline of data.results) {
  console.log(`\nPipeline: "${pipeline.label}" (ID: ${pipeline.id})`)
  console.log('  Stages:')
  const sorted = [...pipeline.stages].sort((a, b) => a.displayOrder - b.displayOrder)
  for (const stage of sorted) {
    console.log(`    "${stage.label}" → ID: ${stage.id}`)
  }
}

console.log('\n--- Copy the IDs above into your .env file ---')
