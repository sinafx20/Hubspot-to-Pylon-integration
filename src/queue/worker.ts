import { Worker } from 'bullmq'
import { config } from '../config'
import { handleCreatePylonProject } from '../jobs/create-pylon-project'
import { handleUpdateDealQuoteSent } from '../jobs/update-deal-quote-sent'
import { handleUpdateDealClosedWon } from '../jobs/update-deal-closed-won'

const connection = { url: config.REDIS_URL }

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
