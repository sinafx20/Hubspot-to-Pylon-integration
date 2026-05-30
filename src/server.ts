import Fastify from 'fastify'
import { config } from './config'
import { hubspotWebhookRoute } from './webhooks/hubspot'
import { pylonWebhookRoute } from './webhooks/pylon'
import { startWorker } from './queue/worker'

const server = Fastify({ logger: true })

server.get('/health', async () => ({ status: 'ok' }))

server.register(hubspotWebhookRoute, { prefix: '/webhooks' })
server.register(pylonWebhookRoute, { prefix: '/webhooks' })

const start = async () => {
  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' })
    startWorker()
    server.log.info(`Integration service running on port ${config.PORT}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
