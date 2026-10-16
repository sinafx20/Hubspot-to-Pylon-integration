/**
 * One-off: make the deal stage internal IDs match their meaning.
 *
 * Before:  closedwon = "Quote Sent" (open)      closedlost = "Quote Accepted / Closed Won"
 *          3086465512 = "Closed Lost"
 * After:   <new id>  = "Quote Sent" (open)      closedwon  = "Quote Accepted / Closed Won"
 *          closedlost = "Closed Lost"           3086465512 deleted
 *
 * Stage IDs can't be renamed in HubSpot, so deals are moved and labels follow. Order matters,
 * because four workflows trigger on these stage IDs (order creation, lifecycle stage changes that
 * start the Quote Sent and welcome email sequences, Pylon re-sync). Each workflow is re-pointed so
 * that no migrated deal ever *newly* meets a trigger:
 *  - list-based triggers are widened to include the destination stage BEFORE deals move (deals
 *    stay members the whole time), then narrowed to the destination only AFTER;
 *  - the event-based order trigger is switched only after the won deals have moved, and before
 *    lost deals enter `closedlost`.
 * All four have re-enrollment off, which is a second layer: deals already enrolled can't re-enrol.
 *
 * Every step checks live state first and skips if already done, so a failed run can be resumed.
 * Run the integration with PAUSE_WORKER=true for the duration.
 *
 * Usage:  npx tsx scripts/remap-stages.ts            (dry run, read-only)
 *         npx tsx scripts/remap-stages.ts --apply
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
const PIPELINE = 'default'
const OLD_LOST = '3086465512'
const QUOTE_SENT_LABEL = 'Quote Sent'
const QUOTE_SENT_TEMP = 'Quote Sent (new)'
const WON_LABEL = 'Quote Accepted / Closed Won'
const LOST_LABEL = 'Closed Lost'

const WF = {
  quoteSentLifecycle: '4258802137', // list: dealstage -> contact lifecycle "Quote Sent" -> Quote Sent sequence
  wonLifecycle: '4253178360', //       list: dealstage -> contact lifecycle "Deal Won" -> welcome email
  orderCreated: '4216904165', //       event: dealstage changed to X -> create Order
  pylonResync: '4406413787', //        event: account added, refined by deal stage -> pylon_sync_requested
}

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
  const p = await hs<{ stages: Stage[] }>('GET', `/crm/v3/pipelines/deals/${PIPELINE}`)
  return p.stages
}
const byId = (all: Stage[], id: string) => all.find((s) => s.id === id)
const byLabel = (all: Stage[], label: string) => all.find((s) => s.label === label)

type Deal = { id: string; properties: { dealstage: string; closedate: string | null; dealname: string } }

async function dealsIn(stageId: string): Promise<Deal[]> {
  const out: Deal[] = []
  let after: string | undefined
  // Search caps at 10k results; these stages hold a few hundred.
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

async function orderCount(): Promise<number> {
  const r = await hs<{ total: number }>('POST', '/crm/v3/objects/orders/search', { limit: 1 })
  return r.total
}

// Contact lifecycle stages the deal workflows set; each one starts an email sequence.
const LIFECYCLE_QUOTE_SENT = '3154595299'
const LIFECYCLE_DEAL_WON = '3147845107'

async function contactsInLifecycle(value: string): Promise<number> {
  const r = await hs<{ total: number }>('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value }] }],
    limit: 1,
  })
  return r.total
}

type Tripwire = { orders: number; quoteSentContacts: number; wonContacts: number }
async function tripwire(): Promise<Tripwire> {
  return {
    orders: await orderCount(),
    quoteSentContacts: await contactsInLifecycle(LIFECYCLE_QUOTE_SENT),
    wonContacts: await contactsInLifecycle(LIFECYCLE_DEAL_WON),
  }
}
let baseline: Tripwire | null = null
const SETTLE_MS = 45_000

async function getFlow(id: string) {
  return hs<any>('GET', `/automation/v4/flows/${id}`)
}

async function putFlow(flow: any) {
  const { id, createdAt, updatedAt, ...body } = flow
  return hs<any>('PUT', `/automation/v4/flows/${id}`, body)
}

// The dealstage values each workflow currently filters on.
function listStages(flow: any): string[] {
  const f = flow.enrollmentCriteria.listFilterBranch.filterBranches[0].filters.find((x: any) => x.property === 'dealstage')
  return f.operation.values
}
function setListStages(flow: any, values: string[]) {
  flow.enrollmentCriteria.listFilterBranch.filterBranches[0].filters.find((x: any) => x.property === 'dealstage').operation.values = values
}
function eventStages(flow: any): string[] {
  const f = flow.enrollmentCriteria.eventFilterBranches[0].filters.find((x: any) => x.property === 'hs_value')
  return f.operation.values
}
function setEventStages(flow: any, values: string[]) {
  flow.enrollmentCriteria.eventFilterBranches[0].filters.find((x: any) => x.property === 'hs_value').operation.values = values
}
function refinementStages(flow: any): string[] {
  const f = flow.enrollmentCriteria.refinementCriteria.filterBranches[0].filterBranches[0].filters.find(
    (x: any) => x.property === 'dealstage'
  )
  return f.operation.values
}
function setRefinementStages(flow: any, values: string[]) {
  flow.enrollmentCriteria.refinementCriteria.filterBranches[0].filterBranches[0].filters.find(
    (x: any) => x.property === 'dealstage'
  ).operation.values = values
}

const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join()

// ---------- step helpers ----------

let stepNo = 0
async function step(name: string, isDone: () => Promise<boolean>, run: () => Promise<void>) {
  stepNo++
  const label = `[${String(stepNo).padStart(2)}] ${name}`
  if (await isDone()) {
    console.log(`${label}  (already done)`)
    return
  }
  if (!APPLY) {
    console.log(`${label}  WOULD RUN`)
    return
  }
  await run()
  if (!(await isDone())) throw new Error(`${label}: ran but state check still fails, stopping here`)
  // Tripwire: workflows run async, so give them time, then confirm nothing was triggered.
  if (baseline) {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const now = await tripwire()
    const changed = (Object.keys(baseline) as (keyof Tripwire)[]).filter((k) => now[k] !== baseline![k])
    if (changed.length) {
      throw new Error(
        `${label}: TRIPWIRE ${changed.map((k) => `${k} ${baseline![k]} -> ${now[k]}`).join(', ')}. ` +
          'Something enrolled; stopping before any further change'
      )
    }
  }
  console.log(`${label}  done (tripwire clear)`)
}

async function flowStep(
  name: string,
  id: string,
  get: (f: any) => string[],
  set: (f: any, v: string[]) => void,
  target: () => string[]
) {
  await step(
    name,
    async () => same(get(await getFlow(id)), target()),
    async () => {
      const f = await getFlow(id)
      if (!f.isEnabled) throw new Error(`workflow ${id} is unexpectedly disabled, stopping`)
      set(f, target())
      await putFlow(f)
    }
  )
}

async function moveDeals(from: string, to: string) {
  const deals = await dealsIn(from)
  for (let i = 0; i < deals.length; i += 100) {
    const chunk = deals.slice(i, i + 100)
    await hs('POST', '/crm/v3/objects/deals/batch/update', {
      inputs: chunk.map((d) => ({
        id: d.id,
        // Re-send closedate so moving between closed stages doesn't restamp it to today.
        properties: { dealstage: to, ...(d.properties.closedate ? { closedate: d.properties.closedate } : {}) },
      })),
    })
  }
  // HubSpot auto-fills closedate on entry to a closed stage; clear it where it was empty before.
  const blanks = deals.filter((d) => !d.properties.closedate).map((d) => d.id)
  const after = await dealsIn(to)
  const stamped = after.filter((d) => blanks.includes(d.id) && d.properties.closedate)
  for (let i = 0; i < stamped.length; i += 100) {
    await hs('POST', '/crm/v3/objects/deals/batch/update', {
      inputs: stamped.slice(i, i + 100).map((d) => ({ id: d.id, properties: { closedate: '' } })),
    })
  }
}

async function patchStage(id: string, body: Record<string, unknown>) {
  await hs('PATCH', `/crm/v3/pipelines/deals/${PIPELINE}/stages/${id}`, body)
}

// ---------- main ----------

async function main() {
  console.log(APPLY ? '=== APPLY MODE: writing to HubSpot ===\n' : '=== DRY RUN: no writes ===\n')

  // Preflight: refuse to start from an unexpected state (resumes are fine, drift is not).
  const s0 = await stages()
  const fresh =
    byId(s0, 'closedwon')?.label === 'Quote Sent' &&
    byId(s0, 'closedlost')?.label === WON_LABEL &&
    byId(s0, OLD_LOST)?.label === LOST_LABEL
  const partial = !!byLabel(s0, QUOTE_SENT_TEMP) || byId(s0, 'closedwon')?.label === WON_LABEL
  if (!fresh && !partial) throw new Error('Pipeline is in neither the original nor a partially-migrated state; inspect manually')

  const snapPath = path.join(__dirname, `../stage-remap-snapshot.local.json`)
  if (!fs.existsSync(snapPath)) {
    const snapshot = {
      takenAt: new Date().toISOString(),
      stages: s0,
      orders: await orderCount(),
      deals: {
        closedwon: await dealsIn('closedwon'),
        closedlost: await dealsIn('closedlost'),
        [OLD_LOST]: await dealsIn(OLD_LOST),
      },
      flows: Object.fromEntries(await Promise.all(Object.values(WF).map(async (id) => [id, await getFlow(id)]))),
    }
    if (APPLY) fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2))
    console.log(
      `Snapshot${APPLY ? ` -> ${path.basename(snapPath)}` : ' (not saved in dry run)'}: ` +
        `orders=${snapshot.orders}, closedwon=${snapshot.deals.closedwon.length}, ` +
        `closedlost=${snapshot.deals.closedlost.length}, ${OLD_LOST}=${snapshot.deals[OLD_LOST].length}\n`
    )
  }
  const snap = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf-8')) : null
  const ordersBefore: number = snap?.orders ?? (await orderCount())
  baseline = await tripwire()
  console.log(`Tripwire baseline: ${JSON.stringify(baseline)}\n`)

  let q = '' // new Quote Sent stage id
  const resolveQ = async () => {
    const all = await stages()
    q = (byLabel(all, QUOTE_SENT_TEMP) ?? (byId(all, 'closedwon')?.label !== 'Quote Sent' ? byLabel(all, QUOTE_SENT_LABEL) : undefined))?.id ?? ''
    return q
  }

  // 1. New open "Quote Sent" stage (temp label, labels must be unique in a pipeline).
  await step(
    `Create stage "${QUOTE_SENT_TEMP}" (open, 70%)`,
    async () => !!(await resolveQ()),
    async () => {
      await hs('POST', `/crm/v3/pipelines/deals/${PIPELINE}/stages`, {
        label: QUOTE_SENT_TEMP,
        displayOrder: 5,
        metadata: { isClosed: 'false', probability: '0.7' },
      })
      await resolveQ()
    }
  )
  const Q = () => q || '<new-quote-sent-id>'

  // 2-4. Quote Sent deals: closedwon -> Q, with the Quote Sent lifecycle workflow widened then narrowed.
  await flowStep('Quote Sent workflow: trigger on [closedwon, new]', WF.quoteSentLifecycle, listStages, setListStages, () => ['closedwon', Q()])
  await step(
    'Move Quote Sent deals closedwon -> new stage',
    async () => !!q && (await dealsIn('closedwon')).length === 0 || byId(await stages(), 'closedwon')?.label === WON_LABEL,
    () => moveDeals('closedwon', q)
  )
  await flowStep('Quote Sent workflow: trigger on [new] only', WF.quoteSentLifecycle, listStages, setListStages, () => [Q()])

  // 5. closedwon (now empty) becomes the won stage. Free the label on closedlost first.
  await step(
    `Relabel closedlost -> "${WON_LABEL} (old)"`,
    async () => byId(await stages(), 'closedlost')?.label !== WON_LABEL,
    () => patchStage('closedlost', { label: `${WON_LABEL} (old)` })
  )
  await step(
    `closedwon -> "${WON_LABEL}" (won, 100%)`,
    async () => {
      const s = byId(await stages(), 'closedwon')!
      return s.label === WON_LABEL && s.metadata.isClosed === 'true' && Number(s.metadata.probability) === 1
    },
    async () => {
      if ((await dealsIn('closedwon')).length) throw new Error('closedwon not empty, refusing to make it the won stage')
      await patchStage('closedwon', { label: WON_LABEL, metadata: { isClosed: 'true', probability: '1.0' } })
    }
  )

  // 6-8. Won deals: closedlost -> closedwon, lifecycle workflow widened then narrowed, order trigger switched after.
  await flowStep('Deal Won workflow: trigger on [closedlost, closedwon]', WF.wonLifecycle, listStages, setListStages, () => ['closedlost', 'closedwon'])
  await step(
    'Move won deals closedlost -> closedwon',
    async () => byId(await stages(), 'closedlost')?.label === LOST_LABEL || (await dealsIn('closedlost')).length === 0,
    () => moveDeals('closedlost', 'closedwon')
  )
  await flowStep('Deal Won workflow: trigger on [closedwon] only', WF.wonLifecycle, listStages, setListStages, () => ['closedwon'])
  await flowStep('Order workflow: trigger on stage -> closedwon', WF.orderCreated, eventStages, setEventStages, () => ['closedwon'])

  // 9. closedlost (now empty) becomes the lost stage. Free the label on the old lost stage first.
  await step(
    `Relabel ${OLD_LOST} -> "${LOST_LABEL} (old)"`,
    async () => byId(await stages(), OLD_LOST)?.label !== LOST_LABEL,
    () => patchStage(OLD_LOST, { label: `${LOST_LABEL} (old)` })
  )
  await step(
    `closedlost -> "${LOST_LABEL}" (lost, 0%)`,
    async () => {
      const s = byId(await stages(), 'closedlost')!
      return s.label === LOST_LABEL && s.metadata.isClosed === 'true' && Number(s.metadata.probability) === 0
    },
    async () => {
      if ((await dealsIn('closedlost')).length) throw new Error('closedlost not empty, refusing to make it the lost stage')
      await patchStage('closedlost', { label: LOST_LABEL, metadata: { isClosed: 'true', probability: '0.0' } })
    }
  )

  // 10. Lost deals: old lost stage -> closedlost. Nothing triggers on closedlost any more.
  await step(
    `Move lost deals ${OLD_LOST} -> closedlost`,
    async () => !byId(await stages(), OLD_LOST) || (await dealsIn(OLD_LOST)).length === 0,
    async () => {
      const won = await getFlow(WF.wonLifecycle)
      const order = await getFlow(WF.orderCreated)
      if (listStages(won).includes('closedlost') || eventStages(order).includes('closedlost')) {
        throw new Error('a won workflow still triggers on closedlost, refusing to move lost deals into it')
      }
      await moveDeals(OLD_LOST, 'closedlost')
    }
  )

  // 11. Pylon re-sync workflow: active quote stages are Ready to quote, Quote Sent, Won.
  await flowStep('Pylon re-sync workflow: stages [contractsent, new, closedwon]', WF.pylonResync, refinementStages, setRefinementStages, () => ['contractsent', Q(), 'closedwon'])

  // 12. Remove the empty old lost stage.
  await step(
    `Delete empty stage ${OLD_LOST}`,
    async () => !byId(await stages(), OLD_LOST),
    async () => {
      if ((await dealsIn(OLD_LOST)).length) throw new Error(`${OLD_LOST} not empty, not deleting`)
      await hs('DELETE', `/crm/v3/pipelines/deals/${PIPELINE}/stages/${OLD_LOST}`)
    }
  )

  // 13. Final label + order.
  await step(
    `Rename new stage -> "${QUOTE_SENT_LABEL}" and fix display order`,
    async () => {
      const all = await stages()
      const s = byId(all, q)
      return !!s && s.label === QUOTE_SENT_LABEL && s.displayOrder === 5 && byId(all, 'closedwon')?.displayOrder === 6 && byId(all, 'closedlost')?.displayOrder === 7
    },
    async () => {
      await patchStage(q, { label: QUOTE_SENT_LABEL, displayOrder: 5 })
      await patchStage('closedwon', { displayOrder: 6 })
      await patchStage('closedlost', { displayOrder: 7 })
    }
  )

  // Verify.
  const sEnd = await stages()
  console.log('\nPipeline now:')
  for (const s of [...sEnd].sort((a, b) => a.displayOrder - b.displayOrder)) {
    const n = (await dealsIn(s.id)).length
    console.log(`  ${s.displayOrder} ${s.id.padEnd(22)} ${s.label.padEnd(32)} closed=${s.metadata.isClosed} p=${s.metadata.probability} deals=${n}`)
  }
  const ordersAfter = await orderCount()
  console.log(`\nOrders: before=${ordersBefore} after=${ordersAfter}${ordersAfter !== ordersBefore ? '  <-- CHECK: orders changed during migration' : ''}`)
  if (APPLY && q) {
    console.log(`\nSet on Railway: HUBSPOT_STAGE_QUOTE_SENT=${q}  HUBSPOT_STAGE_CLOSED_WON=closedwon  (READY_TO_QUOTE unchanged: contractsent)`)
  }
}

main().catch((err) => {
  console.error('\nSTOPPED:', err.message)
  process.exit(1)
})
