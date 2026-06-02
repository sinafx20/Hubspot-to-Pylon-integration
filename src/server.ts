import Fastify from 'fastify'
import { config } from './config'
import { hubspotWebhookRoute } from './webhooks/hubspot'
import { pylonWebhookRoute } from './webhooks/pylon'
import { dashboardRoute } from './admin/dashboard'
import { startWorker } from './queue/worker'

const server = Fastify({ logger: true })

// Store raw body buffer before parsing so webhook signature verification can use original bytes
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  ;(req as any).rawBody = body
  try {
    done(null, JSON.parse((body as Buffer).toString()))
  } catch (err) {
    done(err as Error)
  }
})

// Dashboard Retry/Dismiss buttons submit empty urlencoded forms — accept them (we only use URL params)
server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
  done(null, {})
})

server.get('/health', async () => ({ status: 'ok' }))

server.register(hubspotWebhookRoute, { prefix: '/webhooks' })
server.register(pylonWebhookRoute, { prefix: '/webhooks' })
server.register(dashboardRoute)

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
