import { Queue } from 'bullmq'
import { config } from '../config'

// Pass URL string — BullMQ v5 handles maxRetriesPerRequest: null internally
const connection = { url: config.REDIS_URL }

export const integrationQueue = new Queue('integration', { connection })
