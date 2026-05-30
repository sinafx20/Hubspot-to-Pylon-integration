import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../config'

export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
})

export const integrationQueue = new Queue('integration', { connection: redis })
