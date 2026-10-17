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

  // When true, webhooks are still accepted and queued but the worker doesn't process them. Used
  // during pipeline changes so no job moves a deal while stage IDs are being remapped; unpausing
  // drains the queue, and each job reads the stage IDs from config at run time.
  PAUSE_WORKER: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // Address check: run automatically (after a short delay, so the form workflow has copied the
  // address onto the account) when a deal enters one of these stages.
  HUBSPOT_ADDRESS_CHECK_STAGES: z.string().default('3224932835,appointmentscheduled'),
  ADDRESS_CHECK_DELAY_MS: z.coerce.number().default(180_000),
  // Deal checkbox staff tick to re-check the address (and replace a wrong Pylon project).
  HUBSPOT_ADDRESS_RECHECK_PROP: z.string().default('pylon_address_recheck'),
  // Matches outside these states fail the check (e.g. "Jones St" resolving to NSW).
  ADDRESS_ALLOWED_STATES: z.string().default('VIC'),
  // Optional: Google Geocoding is used first when set; OpenStreetMap is the fallback.
  GOOGLE_MAPS_API_KEY: z.string().optional(),

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
