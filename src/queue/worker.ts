import { Worker } from 'bullmq'
import { config } from '../config'
import { handleCreatePylonProject } from '../jobs/create-pylon-project'
import { handleUpdateDealQuoteSent } from '../jobs/update-deal-quote-sent'
import { handleUpdateDealClosedWon } from '../jobs/update-deal-closed-won'
import { handleCheckAccount, handleCheckDeal } from '../jobs/check-address'
import { integrationQueue } from './index'
import { searchCompanyIds } from '../services/hubspot'

const connection = { url: config.REDIS_URL }

/**
 * Safety net for the account "Re-check address" box: every minute, queue a re-check for any account
 * with it still ticked. Works even if the HubSpot webhook for that property is missing or an event
 * is dropped; the job unticks the box, so each tick is handled once.
 */
export function startRecheckSweep() {
  const sweep = async () => {
    try {
      const ids = await searchCompanyIds(config.HUBSPOT_ADDRESS_RECHECK_PROP, 'true')
      const bucket = Math.floor(Date.now() / 120_000)
      for (const companyId of ids) {
        await integrationQueue.add(
          'check-account',
          { companyId, eventId: `sweep-${companyId}-${bucket}`, trigger: 'recheck' },
          { jobId: `recheck-${companyId}-${bucket}`, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 100 }, removeOnFail: false }
        )
      }
      if (ids.length) console.log(`[recheck-sweep] Queued re-check for ${ids.length} account(s): ${ids.join(', ')}`)
    } catch (err) {
      console.error(`[recheck-sweep] ${(err as Error).message}`)
    }
  }
  setInterval(sweep, 60_000)
  sweep()
}

export function startWorker() {
  const worker = new Worker(
    'integration',
    async (job) => {
      switch (job.name) {
        case 'create-pylon-project':
          return handleCreatePylonProject(job.data)
        case 'update-deal-quote-sent':
          return handleUpdateDealQuoteSent(job.data)
        case 'update-deal-closed-won':
          return handleUpdateDealClosedWon(job.data)
        case 'check-account':
          return handleCheckAccount(job.data)
        case 'check-deal':
          return handleCheckDeal(job.data)
        default:
          throw new Error(`Unknown job type: ${job.name}`)
      }
    },
    {
      connection,
      concurrency: 5,
    }
  )

  worker.on('completed', (job) => {
    console.log(`[worker] Job ${job.name}:${job.id} completed`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.name}:${job?.id} failed:`, err.message)
  })

  return worker
}
