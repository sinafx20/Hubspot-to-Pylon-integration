import Fastify from 'fastify'
import { config } from './config'
import { hubspotWebhookRoute } from './webhooks/hubspot'
import { pylonWebhookRoute } from './webhooks/pylon'
import { dashboardRoute } from './admin/dashboard'
import { startWorker, startRecheckSweep } from './queue/worker'
import { listPipelines } from './services/hubspot'

/**
 * Refuse to start the worker if the stage env vars don't match what the stages actually mean in
 * HubSpot (e.g. QUOTE_SENT pointing at a won stage). Jobs stay queued until the config is fixed,
 * which is far cheaper than deals being moved into the wrong stage and firing its workflows.
 */
async function stageConfigIsValid(): Promise<boolean> {
  try {
    const { results } = await listPipelines()
    const pipeline = results.find((p) => p.id === config.HUBSPOT_PIPELINE_ID)
    if (!pipeline) throw new Error(`pipeline ${config.HUBSPOT_PIPELINE_ID} not found`)
    const stage = (id: string) => pipeline.stages.find((s) => s.id === id)
    const isOpen = (id: string) => stage(id)?.metadata?.isClosed === 'false'
    const isWon = (id: string) =>
      stage(id)?.metadata?.isClosed === 'true' && Number(stage(id)?.metadata?.probability) === 1

    const problems: string[] = []
    if (!isOpen(config.HUBSPOT_STAGE_READY_TO_QUOTE)) problems.push('HUBSPOT_STAGE_READY_TO_QUOTE is not an open stage')
    if (!isOpen(config.HUBSPOT_STAGE_QUOTE_SENT)) problems.push('HUBSPOT_STAGE_QUOTE_SENT is not an open stage')
    if (!isWon(config.HUBSPOT_STAGE_CLOSED_WON)) problems.push('HUBSPOT_STAGE_CLOSED_WON is not a won (closed, 100%) stage')
    if (problems.length) {
      server.log.error(`Worker NOT started, stage config mismatch: ${problems.join('; ')}`)
      return false
    }
    server.log.info(
      `Stages OK: ready=${stage(config.HUBSPOT_STAGE_READY_TO_QUOTE)!.label}, ` +
        `quoteSent=${stage(config.HUBSPOT_STAGE_QUOTE_SENT)!.label}, won=${stage(config.HUBSPOT_STAGE_CLOSED_WON)!.label}`
    )
    return true
  } catch (err) {
    // Only a confirmed MISMATCH holds the worker. If the check itself can't run (e.g. a missing
    // scope), start anyway rather than stalling every sync, and say so loudly.
    server.log.warn(`Could not verify stage config, starting worker anyway: ${(err as Error).message}`)
    return true
  }
}

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
    if (config.PAUSE_WORKER) {
      server.log.warn('PAUSE_WORKER=true: webhooks are queued but not processed')
    } else if (await stageConfigIsValid()) {
      startWorker()
      startRecheckSweep()
    }
    server.log.info(`Integration service running on port ${config.PORT}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
