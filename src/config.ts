import { z } from 'zod'

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // HubSpot
  HUBSPOT_ACCESS_TOKEN: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_PIPELINE_ID: z.string().min(1),
  HUBSPOT_STAGE_READY_TO_QUOTE: z.string().min(1),
  HUBSPOT_STAGE_QUOTE_SENT: z.string().min(1),
  HUBSPOT_STAGE_CLOSED_WON: z.string().min(1),
  // Deal checkbox a workflow sets to re-create Pylon projects for newly-added accounts.
  HUBSPOT_SYNC_REQUESTED_PROP: z.string().default('pylon_sync_requested'),

  // Pylon
  PYLON_API_TOKEN: z.string().min(1),
  PYLON_WEBHOOK_SECRET: z.string().optional(),
})

const parsed = env.safeParse(process.env)

if (!parsed.success) {
  console.error('Missing or invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
