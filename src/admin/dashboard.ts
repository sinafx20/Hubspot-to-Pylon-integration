import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Job } from 'bullmq'
import { integrationQueue } from '../queue/index'
import { getDeal, getAssociatedContact, getAssociatedCompany } from '../services/hubspot'
import { searchCandidates } from '../services/geocode'
import { getLinkByProjectId } from '../db/links'

// ---- plain-language helpers (this page is for non-technical staff) ----

function friendlyJobTitle(name: string): string {
  switch (name) {
    case 'create-pylon-project':
      return 'Create the solar project in Pylon'
    case 'update-deal-quote-sent':
      return "Move the deal to ‘Quote Sent’ and copy the quote details"
    case 'update-deal-closed-won':
      return "Move the deal to ‘Quote Accepted’"
    default:
      return name
  }
}

function explainError(reason: string): { what: string; fix: string } {
  const r = (reason || '').toLowerCase()
  if (r.includes('no hubspot deal linked') || r.includes('not created via this integration')) {
    return {
      what: 'This proposal was for a Pylon project that isn’t linked to a HubSpot deal — usually because the project was created directly in Pylon rather than from a HubSpot deal.',
      fix: 'If this should be a HubSpot deal, create the deal in HubSpot first. Otherwise it’s safe to click Dismiss.',
    }
  }
  if (r.includes('missing_scopes') || r.includes('required scopes') || r.includes(' 403')) {
    return {
      what: 'The HubSpot connection is missing a permission it needs.',
      fix: 'Ask your developer to enable the missing permission on the HubSpot private app, then click Retry.',
    }
  }
  if (r.includes('incomplete address')) {
    return {
      what: "The customer’s address in HubSpot is missing something Pylon needs (street, suburb or postcode), so the project couldn’t be created.",
      fix: 'Open the deal’s contact in HubSpot, fill in the Install Address, suburb and postcode, then click Retry.',
    }
  }
  if (r.includes('geocode') || r.includes('site_location') || (r.includes('422') && r.includes('pylon'))) {
    return {
      what: "We couldn’t turn the customer’s address into a map location, so Pylon wouldn’t accept it.",
      fix: 'Open the deal’s contact in HubSpot and make sure the street address, suburb and postcode are filled in correctly — then click Retry.',
    }
  }
  if (r.includes('401') || r.includes('unauthorized') || r.includes('invalid signature') || r.includes('token')) {
    return {
      what: 'An access token (HubSpot or Pylon) was rejected.',
      fix: 'The token may have expired or changed. Ask your developer to check the tokens in Railway, then click Retry.',
    }
  }
  if (r.includes('429') || r.includes('rate')) {
    return {
      what: 'Too many requests were sent too quickly and the system was temporarily blocked.',
      fix: 'Wait a minute, then click Retry.',
    }
  }
  if (
    r.includes('econnreset') ||
    r.includes('etimedout') ||
    r.includes('fetch failed') ||
    r.includes('network') ||
    r.includes('502') ||
    r.includes('503') ||
    r.includes('504')
  ) {
    return {
      what: 'A temporary connection problem with HubSpot or Pylon.',
      fix: 'This usually sorts itself out — click Retry. If it keeps happening, wait a few minutes and try again.',
    }
  }
  return {
    what: 'Something went wrong while syncing this deal.',
    fix: 'Click Retry. If it keeps failing, send this page to your developer.',
  }
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function timeAgo(ms?: number): string {
  if (!ms) return 'unknown time'
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// Resolve the HubSpot deal id behind a failed job (directly, or via the Pylon link).
async function resolveDealId(job: Job): Promise<string | undefined> {
  let dealId: string | undefined = job.data?.dealId
  if (!dealId && job.data?.pylonProjectId) {
    const link = await getLinkByProjectId(job.data.pylonProjectId)
    dealId = link?.hubspot_deal_id
  }
  return dealId
}

// Best-effort: find a human-friendly label (deal name) for a failed job.
async function describeDeal(job: Job): Promise<string> {
  try {
    const dealId = await resolveDealId(job)
    if (!dealId) return job.data?.pylonProjectId ? `Pylon project ${job.data.pylonProjectId}` : 'Unknown deal'
    const deal = await getDeal(dealId)
    return `${deal.properties.dealname ?? 'Deal'} (#${dealId})`
  } catch {
    return job.data?.dealId ? `Deal #${job.data.dealId}` : 'Unknown deal'
  }
}

// For a geocode failure, look up the closest real address Nominatim can find and
// tell staff the exact text to paste into the contact's Install Address in HubSpot.
// Returns an HTML snippet, or '' if we can't suggest anything.
async function buildAddressSuggestion(job: Job): Promise<string> {
  try {
    const dealId = await resolveDealId(job)
    if (!dealId) return ''
    const [contact, company] = await Promise.all([
      getAssociatedContact(dealId).catch(() => null),
      getAssociatedCompany(dealId).catch(() => null),
    ])
    const c = contact?.properties
    const co = company?.properties

    const candidates = await searchCandidates({
      parts: {
        street: c?.install_address ?? co?.address ?? undefined,
        city: c?.city ?? co?.city ?? undefined,
        state: c?.state ?? co?.state ?? undefined,
        postcode: c?.zip ?? co?.zip ?? undefined,
      },
      free: c?.install_address ?? co?.name ?? c?.address ?? co?.address ?? undefined,
    })
    if (!candidates.length) return ''

    const top = candidates[0]
    const note =
      top.precision === 'rooftop'
        ? 'This is a confirmed address — paste it exactly into the contact’s <b>Install Address</b> field in HubSpot, then click Retry.'
        : 'We could only match the suburb, not the exact street. Use this as a guide: fix the street number/name in the contact’s <b>Install Address</b> field in HubSpot so it matches a real address, then click Retry.'

    const alts = candidates
      .slice(1, 3)
      .map((alt) => `<li>${esc(alt.display)}</li>`)
      .join('')

    return `<div class="suggest">
      <div class="suggest-label">📍 Closest match we found:</div>
      <div class="suggest-addr">${esc(top.display)}</div>
      <p class="suggest-note">${note}</p>
      ${alts ? `<details><summary>Other possible matches</summary><ul>${alts}</ul></details>` : ''}
    </div>`
  } catch {
    return ''
  }
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sync Health</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;color:#1b2733;margin:0;padding:24px;}
  .wrap{max-width:760px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 4px;}
  .sub{color:#5b6b7b;margin:0 0 20px;font-size:14px;}
  .ok{background:#e7f7ed;border:1px solid #b7e4c7;color:#1b6b3a;padding:20px;border-radius:10px;font-size:16px;}
  .card{background:#fff;border:1px solid #e1e7ee;border-radius:10px;padding:16px 18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.04);}
  .card h2{font-size:16px;margin:0 0 6px;}
  .deal{color:#0b66c3;font-weight:600;}
  .meta{color:#7a8896;font-size:13px;margin-bottom:10px;}
  .what{margin:0 0 6px;}
  .fix{background:#fff7e6;border:1px solid #ffe2a8;border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 12px;}
  .fix b{color:#915b00;}
  .suggest{background:#eef5ff;border:1px solid #c4dbff;border-radius:8px;padding:10px 12px;font-size:14px;margin:0 0 12px;}
  .suggest-label{color:#0b66c3;font-weight:600;font-size:13px;}
  .suggest-addr{font-weight:600;margin:4px 0;user-select:all;}
  .suggest-note{margin:4px 0 0;color:#42566b;font-size:13px;}
  .suggest details{margin-top:6px;}
  .suggest ul{margin:6px 0 0;padding-left:18px;color:#42566b;font-size:13px;}
  .btns form{display:inline;}
  button{font-size:14px;padding:8px 16px;border-radius:8px;border:0;cursor:pointer;margin-right:8px;}
  .retry{background:#0b66c3;color:#fff;}
  .dismiss{background:#eef1f4;color:#46566a;}
  details{margin-top:10px;}
  summary{cursor:pointer;color:#7a8896;font-size:13px;}
  pre{background:#0f172a;color:#cbd5e1;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap;}
  .top{display:flex;justify-content:space-between;align-items:baseline;}
  a.refresh{font-size:13px;color:#0b66c3;text-decoration:none;}
</style></head><body><div class="wrap">${body}</div></body></html>`
}

export async function dashboardRoute(fastify: FastifyInstance) {
  fastify.get('/dashboard', async (_req: FastifyRequest, reply: FastifyReply) => {
    const failed = await integrationQueue.getFailed(0, 100)

    const header = `<div class="top"><div>
      <h1>Sync Health</h1>
      <p class="sub">Deals that didn’t sync between HubSpot and Pylon after automatic retries.</p>
      </div><a class="refresh" href="/dashboard">↻ Refresh</a></div>`

    if (failed.length === 0) {
      reply.type('text/html')
      return page(`${header}<div class="ok">✅ All syncs are healthy — nothing needs attention.</div>`)
    }

    const cards = await Promise.all(
      failed.map(async (job) => {
        const dealLabel = await describeDeal(job)
        const reason = job.failedReason || ''
        const { what, fix } = explainError(reason)
        const isGeocode =
          reason.toLowerCase().includes('geocode') ||
          reason.toLowerCase().includes('site_location') ||
          reason.toLowerCase().includes('incomplete address') ||
          (reason.toLowerCase().includes('422') && reason.toLowerCase().includes('pylon'))
        const suggestion = isGeocode ? await buildAddressSuggestion(job) : ''
        return `<div class="card">
          <h2>${esc(friendlyJobTitle(job.name))}</h2>
          <div class="deal">${esc(dealLabel)}</div>
          <div class="meta">Failed ${esc(timeAgo(job.finishedOn))} · tried ${esc(job.attemptsMade)} time(s)</div>
          <p class="what">${esc(what)}</p>
          <div class="fix"><b>What to do:</b> ${esc(fix)}</div>
          ${suggestion}
          <div class="btns">
            <form method="post" action="/dashboard/retry/${esc(job.id)}"><button class="retry" type="submit">↻ Retry now</button></form>
            <form method="post" action="/dashboard/dismiss/${esc(job.id)}"><button class="dismiss" type="submit">Dismiss</button></form>
          </div>
          <details><summary>Technical details (for your developer)</summary><pre>${esc(job.failedReason || 'No error message')}</pre></details>
        </div>`
      })
    )

    reply.type('text/html')
    return page(
      `${header}<p class="sub">${failed.length} sync${failed.length === 1 ? '' : 's'} need attention:</p>${cards.join('')}`
    )
  })

  // Retry a single failed job, then return to the dashboard.
  fastify.post('/dashboard/retry/:jobId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = req.params as { jobId: string }
    const job = await integrationQueue.getJob(jobId)
    if (job) {
      try {
        await job.retry()
        console.log(`[dashboard] Retried job ${job.name}:${jobId}`)
      } catch (err) {
        console.error(`[dashboard] Failed to retry job ${jobId}:`, (err as Error).message)
      }
    }
    reply.redirect('/dashboard')
  })

  // Remove a failed job from the list without retrying.
  fastify.post('/dashboard/dismiss/:jobId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { jobId } = req.params as { jobId: string }
    const job = await integrationQueue.getJob(jobId)
    if (job) {
      try {
        await job.remove()
        console.log(`[dashboard] Dismissed job ${jobId}`)
      } catch (err) {
        console.error(`[dashboard] Failed to dismiss job ${jobId}:`, (err as Error).message)
      }
    }
    reply.redirect('/dashboard')
  })
}
