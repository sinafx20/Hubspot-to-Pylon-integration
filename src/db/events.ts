import { db } from './index'

export async function isEventProcessed(eventId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM sync_events WHERE event_id = $1 AND status = 'success'`,
    [eventId]
  )
  return result.rows.length > 0
}

/**
 * True if this Pylon project has already had a successful quote-sent sync from a *different*
 * event — i.e. the current event is a re-share/revision rather than the first send. Used to
 * title the activity note "updated" vs "sent". Excludes the current event id, which the job
 * logs as success before the enrichment step runs.
 */
export async function hasPriorQuoteSync(pylonProjectId: string, currentEventId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM sync_events
       WHERE pylon_project_id = $1
         AND event_id <> $2
         AND event_type IN ('proposals.shared', 'esignature_requests.sent')
         AND status = 'success'
     LIMIT 1`,
    [pylonProjectId, currentEventId]
  )
  return result.rows.length > 0
}

export async function logEvent(params: {
  eventId?: string
  direction: 'hs_to_pylon' | 'pylon_to_hs'
  eventType: string
  hubspotDealId?: string
  pylonProjectId?: string
  status: 'queued' | 'success' | 'failed' | 'dead' | 'duplicate' | 'skipped'
  errorMessage?: string
}) {
  await db.query(
    `INSERT INTO sync_events
       (event_id, direction, event_type, hubspot_deal_id, pylon_project_id, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (event_id) DO UPDATE
       SET status        = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           updated_at    = NOW()`,
    [
      params.eventId ?? null,
      params.direction,
      params.eventType,
      params.hubspotDealId ?? null,
      params.pylonProjectId ?? null,
      params.status,
      params.errorMessage ?? null,
    ]
  )
}
