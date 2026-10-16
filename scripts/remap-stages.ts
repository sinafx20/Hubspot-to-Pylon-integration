/**
 * One-off: make the deal stage internal IDs match their meaning.
 *
 * Before:  contractsent = "Ready to quote"            closedwon  = "Quote Sent" (open)
 *          closedlost   = "Quote Accepted / Closed Won" 3086465512 = "Closed Lost"
 * After:   <new id>     = "Ready to quote"            contractsent = "Quote Sent"
 *          closedwon    = "Quote Accepted / Closed Won" closedlost = "Closed Lost"
 *          3086465512 deleted
 *
 * Stage IDs can't be renamed in HubSpot, so deals are moved and labels follow.
 *
 * The integration must be paused first, by setting all three HUBSPOT_STAGE_* vars on Railway to a
 * non-existent stage (e.g. PAUSED). Then:
 *  - no deal move can look like "entered Ready to quote" (no duplicate Pylon projects), and
 *  - Pylon proposal events fail their stage update and wait on /dashboard for "Retry now".
 *
 * Four HubSpot workflows trigger on these stage IDs (order creation, lifecycle changes that start
 * the Quote Sent and welcome email sequences, Pylon re-sync). They are re-pointed so no migrated
 * deal ever *newly* meets a trigger:
 *  - list-based triggers are widened to include the destination stage BEFORE deals move (deals
 *    stay members the whole time), then narrowed to the destination only AFTER, and only ever
 *    widened onto an EMPTY stage;
 *  - the event-based order trigger is switched only after the won deals have moved, and before
 *    lost deals enter `closedlost`.
 * All four have re-enrollment off, so deals already enrolled can't re-enrol.
 * After every write step a tripwire waits, then checks order count and contact lifecycle counts
 * are unchanged; if anything moved it stops before the next change.
 *
 * Every step checks live state first and skips if already done, so a stopped run can be resumed.
 *
 * Usage:  npx tsx scripts/remap-stages.ts                                (dry run, read-only)
 *         npx tsx scripts/remap-stages.ts --apply --integration-paused
 */
import fs from 'fs'
import path from 'path'

const envPath = path.join(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key && !key.startsWith('#') && rest.length) process.env[key.trim()] = rest.join('=').trim()
  }
}
const token = process.env.HUBSPOT_ACCESS_TOKEN
if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN not set in .env')

const APPLY = process.argv.includes('--apply')
if (APPLY && !process.argv.includes('--integration-paused')) {
  throw new Error('Pause the integration on Railway first, then pass --integration-paused to confirm')
}
const stopIdx = process.argv.indexOf('--stop-after')
const STOP_AFTER = stopIdx > -1 ? Number(process.argv[stopIdx + 1]) : 0

const PIPELINE = 'default'
const OLD_LOST = '3086465512'
const KNOWN = ['3224932835', 'appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'contractsent', 'closedwon', 'closedlost', OLD_LOST]
const READY = 'Ready to quote'
const READY_TEMP = 'Ready to quote (new)'
const QUOTE_SENT = 'Quote Sent'
const QUOTE_SENT_TEMP = 'Quote Sent (new)'
const WON = 'Quote Accepted / Closed Won'
const LOST = 'Closed Lost'

const WF = {
  quoteSentLifecycle: '4258802137', // list: dealstage -> contact lifecycle "Quote Sent" -> Quote Sent sequence
  wonLifecycle: '4253178360', //       list: dealstage -> contact lifecycle "Deal Won" -> welcome email
  orderCreated: '4216904165', //       event: dealstage changed to X -> create Order
  pylonResync: '4406413787', //        event: account added, refined by deal stage -> pylon_sync_requested
}

// Contact lifecycle stages the deal workflows set; each one starts an email sequence.
const LIFECYCLE_QUOTE_SENT = '3154595299'
const LIFECYCLE_DEAL_WON = '3147845107'
const SETTLE_MS = 45_000

// ---------- HubSpot plumbing ----------

async function hs<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.hubapi.com${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`)
    return (text ? JSON.parse(text) : {}) as T
  }
}

type Stage = { id: string; label: string; displayOrder: number; metadata: { isClosed: string; probability: string } }

async function stages(): Promise<Stage[]> {
  return (await hs<{ stages: Stage[] }>('GET', `/crm/v3/pipelines/deals/${PIPELINE}`)).stages
}
async function stage(id: string): Promise<Stage | undefined> {
  return (await stages()).find((s) => s.id === id)
}
const isOpen = (s: Stage | undefined, p: number) => s?.metadata.isClosed === 'false' && Number(s.metadata.probability) === p
const isClosedAt = (s: Stage | undefined, p: number) => s?.metadata.isClosed === 'true' && Number(s.metadata.probability) === p

type Deal = { id: string; properties: { dealstage: string; closedate: string | null; dealname: string } }

async function dealsIn(stageId: string): Promise<Deal[]> {
  const out: Deal[] = []
  let after: string | undefined
  do {
    const r = await hs<{ results: Deal[]; paging?: { next?: { after: string } } }>('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'dealstage', operator: 'EQ', value: stageId }] }],
      properties: ['dealstage', 'closedate', 'dealname'],
      limit: 100,
      after,
    })
    out.push(...r.results)
    after = r.paging?.next?.after
  } while (after)
  return out
}
const countIn = async (stageId: string) => (await dealsIn(stageId)).length

async function total(object: string, filters: unknown[] = []): Promise<number> {
  return (await hs<{ total: number }>('POST', `/crm/v3/objects/${object}/search`, { filterGroups: filters.length ? [{ filters }] : [], limit: 1 })).total
}

type Tripwire = { orders: number; quoteSentContacts: number; wonContacts: number }
async function tripwire(): Promise<Tripwire> {
  return {
    orders: await total('orders'),
    quoteSentContacts: await total('contacts', [{ propertyName: 'lifecyclestage', operator: 'EQ', value: LIFECYCLE_QUOTE_SENT }]),
    wonContacts: await total('contacts', [{ propertyName: 'lifecyclestage', operator: 'EQ', value: LIFECYCLE_DEAL_WON }]),
  }
}
let baseline: Tripwire | null = null

async function getFlow(id: string) {
  return hs<any>('GET', `/automation/v4/flows/${id}`)
}
async function putFlow(flow: any) {
  const { id, createdAt, updatedAt, ...body } = flow
  return hs<any>('PUT', `/automation/v4/flows/${id}`, body)
}

const listFilter = (f: any) => f.enrollmentCriteria.listFilterBranch.filterBranches[0].filters.find((x: any) => x.property === 'dealstage')
const eventFilter = (f: any) => f.enrollmentCriteria.eventFilterBranches[0].filters.find((x: any) => x.property === 'hs_value')
const refineFilter = (f: any) =>
  f.enrollmentCriteria.refinementCriteria.filterBranches[0].filterBranches[0].filters.find((x: any) => x.property === 'dealstage')

const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()

// ---------- step runner ----------

let stepNo = 0
async function step(name: string, isDone: () => Promise<boolean>, run: () => Promise<void>) {
  stepNo++
  const label = `[${String(stepNo).padStart(2)}] ${name}`
  if (await isDone()) return console.log(`${label}  (already done)`)
  if (STOP_AFTER && stepNo > STOP_AFTER) return console.log(`${label}  not run (--stop-after ${STOP_AFTER})`)
  if (!APPLY) return console.log(`${label}  WOULD RUN`)

  await run()
  if (!(await isDone())) throw new Error(`${label}: ran but state check still fails, stopping here`)
  // Tripwire: workflows run async, so give them time, then confirm nothing was triggered.
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  const now = await tripwire()
  const changed = (Object.keys(baseline!) as (keyof Tripwire)[]).filter((k) => now[k] !== baseline![k])
  if (changed.length) {
    throw new Error(`${label}: TRIPWIRE ${changed.map((k) => `${k} ${baseline![k]} -> ${now[k]}`).join(', ')}. Stopping before any further change`)
  }
  console.log(`${label}  done (tripwire clear)`)
}

async function flowStep(name: string, id: string, filter: (f: any) => any, target: () => string[], mustBeEmpty: string[] = []) {
  await step(
    name,
    async () => same(filter(await getFlow(id)).operation.values ?? [], target()),
    async () => {
      // Only widen a trigger onto stages with no deals in them, so nobody newly matches.
      for (const s of mustBeEmpty) if (await countIn(s)) throw new Error(`${s} is not empty, refusing to add it to workflow ${id}`)
      const f = await getFlow(id)
      if (!f.isEnabled) throw new Error(`workflow ${id} is unexpectedly disabled, stopping`)
      filter(f).operation.values = target()
      await putFlow(f)
    }
  )
}

async function moveDeals(from: string, to: string) {
  const deals = await dealsIn(from)
  for (let i = 0; i < deals.length; i += 100) {
    await hs('POST', '/crm/v3/objects/deals/batch/update', {
      inputs: deals.slice(i, i + 100).map((d) => ({
        id: d.id,
        // Re-send closedate so moving between closed stages doesn't restamp it to today.
        properties: { dealstage: to, ...(d.properties.closedate ? { closedate: d.properties.closedate } : {}) },
      })),
    })
  }
  // HubSpot auto-fills closedate on entry to a closed stage; clear it where it was empty before.
  const blanks = new Set(deals.filter((d) => !d.properties.closedate).map((d) => d.id))
  const stamped = (await dealsIn(to)).filter((d) => blanks.has(d.id) && d.properties.closedate)
  for (let i = 0; i < stamped.length; i += 100) {
    await hs('POST', '/crm/v3/objects/deals/batch/update', {
      inputs: stamped.slice(i, i + 100).map((d) => ({ id: d.id, properties: { closedate: '' } })),
    })
  }
}

async function patchStage(id: string, body: Record<string, unknown>) {
  await hs('PATCH', `/crm/v3/pipelines/deals/${PIPELINE}/stages/${id}`, body)
}
async function patchEmptyStage(id: string, body: Record<string, unknown>) {
  if (await countIn(id)) throw new Error(`${id} is not empty, refusing to change what it means`)
  await patchStage(id, body)
}

// ---------- main ----------

async function main() {
  console.log(APPLY ? '=== APPLY MODE: writing to HubSpot ===\n' : '=== DRY RUN: no writes ===\n')

  const s0 = await stages()
  const byId = (id: string) => s0.find((s) => s.id === id)
  const fresh =
    byId('contractsent')?.label === READY && byId('closedwon')?.label === QUOTE_SENT && byId('closedlost')?.label === WON && byId(OLD_LOST)?.label === LOST
  const partial = s0.some((s) => !KNOWN.includes(s.id) && s.label.startsWith(READY))
  if (!fresh && !partial) throw new Error('Pipeline is in neither the original nor a partially-migrated state; inspect manually')

  const snapPath = path.join(__dirname, '../stage-remap-snapshot.local.json')
  if (!fs.existsSync(snapPath)) {
    const snapshot = {
      takenAt: new Date().toISOString(),
      stages: s0,
      deals: Object.fromEntries(await Promise.all(['contractsent', 'closedwon', 'closedlost', OLD_LOST].map(async (s) => [s, await dealsIn(s)]))),
      flows: Object.fromEntries(await Promise.all(Object.values(WF).map(async (id) => [id, await getFlow(id)]))),
    }
    if (APPLY) fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2))
    const n = (s: string) => snapshot.deals[s].length
    console.log(
      `Snapshot${APPLY ? ` -> ${path.basename(snapPath)}` : ' (not saved in dry run)'}: ` +
        `contractsent=${n('contractsent')}, closedwon=${n('closedwon')}, closedlost=${n('closedlost')}, ${OLD_LOST}=${n(OLD_LOST)}`
    )
  }
  const snap = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf-8')) : null
  baseline = await tripwire()
  console.log(`Tripwire baseline: ${JSON.stringify(baseline)}\n`)

  let r = '' // new Ready to quote stage id
  const resolveR = async () => (r = (await stages()).find((s) => !KNOWN.includes(s.id) && s.label.startsWith(READY))?.id ?? '')
  await resolveR()
  const R = () => r || '<new-ready-id>'

  // --- Ready to quote: contractsent -> new stage ---
  await step(
    `Create stage "${READY_TEMP}" (open, 50%)`,
    async () => !!(await resolveR()),
    async () => {
      await hs('POST', `/crm/v3/pipelines/deals/${PIPELINE}/stages`, { label: READY_TEMP, displayOrder: 4, metadata: { isClosed: 'false', probability: '0.5' } })
      await resolveR()
    }
  )
  await step(
    'Move Ready to quote deals contractsent -> new stage',
    async () => (await stage('contractsent'))?.label !== READY || (await countIn('contractsent')) === 0,
    () => moveDeals('contractsent', r)
  )

  // --- Quote Sent: closedwon -> contractsent ---
  await step(
    `contractsent -> "${QUOTE_SENT_TEMP}" (open, 70%)`,
    async () => {
      const s = await stage('contractsent')
      return (s?.label === QUOTE_SENT_TEMP || s?.label === QUOTE_SENT) && isOpen(s, 0.7)
    },
    () => patchEmptyStage('contractsent', { label: QUOTE_SENT_TEMP, metadata: { isClosed: 'false', probability: '0.7' } })
  )
  await flowStep('Quote Sent workflow: trigger on [closedwon, contractsent]', WF.quoteSentLifecycle, listFilter, () => ['closedwon', 'contractsent'], ['contractsent'])
  await step(
    'Move Quote Sent deals closedwon -> contractsent',
    async () => (await stage('closedwon'))?.label === WON || (await countIn('closedwon')) === 0,
    () => moveDeals('closedwon', 'contractsent')
  )
  await flowStep('Quote Sent workflow: trigger on [contractsent] only', WF.quoteSentLifecycle, listFilter, () => ['contractsent'])

  // --- Won: closedlost -> closedwon ---
  await step(`Relabel closedlost -> "${WON} (old)"`, async () => (await stage('closedlost'))?.label !== WON, () => patchStage('closedlost', { label: `${WON} (old)` }))
  await step(
    `closedwon -> "${WON}" (won, 100%)`,
    async () => {
      const s = await stage('closedwon')
      return s?.label === WON && isClosedAt(s, 1)
    },
    () => patchEmptyStage('closedwon', { label: WON, metadata: { isClosed: 'true', probability: '1.0' } })
  )
  await flowStep('Deal Won workflow: trigger on [closedlost, closedwon]', WF.wonLifecycle, listFilter, () => ['closedlost', 'closedwon'], ['closedwon'])
  await step(
    'Move won deals closedlost -> closedwon',
    async () => (await stage('closedlost'))?.label === LOST || (await countIn('closedlost')) === 0,
    () => moveDeals('closedlost', 'closedwon')
  )
  await flowStep('Deal Won workflow: trigger on [closedwon] only', WF.wonLifecycle, listFilter, () => ['closedwon'])
  await flowStep('Order workflow: trigger on stage -> closedwon', WF.orderCreated, eventFilter, () => ['closedwon'])

  // --- Lost: 3086465512 -> closedlost ---
  await step(`Relabel ${OLD_LOST} -> "${LOST} (old)"`, async () => (await stage(OLD_LOST))?.label !== LOST, () => patchStage(OLD_LOST, { label: `${LOST} (old)` }))
  await step(
    `closedlost -> "${LOST}" (lost, 0%)`,
    async () => {
      const s = await stage('closedlost')
      return s?.label === LOST && isClosedAt(s, 0)
    },
    () => patchEmptyStage('closedlost', { label: LOST, metadata: { isClosed: 'true', probability: '0.0' } })
  )
  await step(
    `Move lost deals ${OLD_LOST} -> closedlost`,
    async () => !(await stage(OLD_LOST)) || (await countIn(OLD_LOST)) === 0,
    async () => {
      if (listFilter(await getFlow(WF.wonLifecycle)).operation.values.includes('closedlost') || eventFilter(await getFlow(WF.orderCreated)).operation.values.includes('closedlost')) {
        throw new Error('a won workflow still triggers on closedlost, refusing to move lost deals into it')
      }
      await moveDeals(OLD_LOST, 'closedlost')
    }
  )

  // --- Pylon re-sync workflow: the active quoting stages ---
  await flowStep('Pylon re-sync workflow: stages [new Ready, contractsent, closedwon]', WF.pylonResync, refineFilter, () => [R(), 'contractsent', 'closedwon'])

  // --- Cleanup ---
  await step(`Delete empty stage ${OLD_LOST}`, async () => !(await stage(OLD_LOST)), async () => {
    if (await countIn(OLD_LOST)) throw new Error(`${OLD_LOST} not empty, not deleting`)
    await hs('DELETE', `/crm/v3/pipelines/deals/${PIPELINE}/stages/${OLD_LOST}`)
  })
  await step(
    'Final labels and display order',
    async () => {
      const all = await stages()
      const g = (id: string) => all.find((s) => s.id === id)
      return g(r)?.label === READY && g(r)?.displayOrder === 4 && g('contractsent')?.label === QUOTE_SENT && g('contractsent')?.displayOrder === 5 &&
        g('closedwon')?.displayOrder === 6 && g('closedlost')?.displayOrder === 7
    },
    async () => {
      await patchStage(r, { label: READY, displayOrder: 4 })
      await patchStage('contractsent', { label: QUOTE_SENT, displayOrder: 5 })
      await patchStage('closedwon', { displayOrder: 6 })
      await patchStage('closedlost', { displayOrder: 7 })
    }
  )

  // --- Report ---
  console.log('\nPipeline now:')
  for (const s of [...(await stages())].sort((a, b) => a.displayOrder - b.displayOrder)) {
    console.log(`  ${s.displayOrder} ${s.id.padEnd(22)} ${s.label.padEnd(32)} closed=${s.metadata.isClosed} p=${s.metadata.probability} deals=${await countIn(s.id)}`)
  }
  console.log(`\nTripwire now: ${JSON.stringify(await tripwire())}`)

  if (r && snap) {
    // Deals that reached Ready to quote while the integration was paused won't have a Pylon project.
    const migrated = new Set((snap.deals.contractsent as Deal[]).map((d) => d.id))
    const late = (await dealsIn(r)).filter((d) => !migrated.has(d.id))
    console.log(
      late.length
        ? `\n${late.length} deal(s) entered Ready to quote during the window, re-sync them after unpausing:\n` + late.map((d) => `  ${d.id}  ${d.properties.dealname}`).join('\n')
        : '\nNo deals entered Ready to quote during the window.'
    )
    console.log(`\nUnpause on Railway: HUBSPOT_STAGE_READY_TO_QUOTE=${r}  HUBSPOT_STAGE_QUOTE_SENT=contractsent  HUBSPOT_STAGE_CLOSED_WON=closedwon`)
  }
}

main().catch((err) => {
  console.error('\nSTOPPED:', err.message)
  process.exit(1)
})
