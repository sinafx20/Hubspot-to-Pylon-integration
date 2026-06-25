import { db } from './index'

export interface DealProjectLink {
  hubspot_deal_id: string
  hubspot_account_id: string | null
  pylon_project_id: string
  is_primary: boolean
}

/**
 * Upsert a link for one (deal, account) → Pylon project. A deal can have several accounts
 * (properties), each its own project; the primary account's project is the anchor. Legacy /
 * contact-based projects pass accountId = null.
 */
export async function saveLink(
  hubspotDealId: string,
  hubspotAccountId: string | null,
  pylonProjectId: string,
  isPrimary: boolean
) {
  await db.query(
    `INSERT INTO deal_project_links (hubspot_deal_id, hubspot_account_id, pylon_project_id, is_primary)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (hubspot_deal_id, COALESCE(hubspot_account_id, '')) DO UPDATE
       SET pylon_project_id = EXCLUDED.pylon_project_id,
           is_primary       = EXCLUDED.is_primary,
           last_synced_at   = NOW()`,
    [hubspotDealId, hubspotAccountId, pylonProjectId, isPrimary]
  )
}

/** All projects linked to a deal (one per account). */
export async function getLinksByDealId(hubspotDealId: string): Promise<DealProjectLink[]> {
  const result = await db.query(
    `SELECT hubspot_deal_id, hubspot_account_id, pylon_project_id, is_primary
       FROM deal_project_links WHERE hubspot_deal_id = $1`,
    [hubspotDealId]
  )
  return result.rows
}

/** The link for one specific (deal, account) slot — used for per-account idempotency. */
export async function getLinkByDealAccount(
  hubspotDealId: string,
  hubspotAccountId: string | null
): Promise<DealProjectLink | undefined> {
  const result = await db.query(
    `SELECT hubspot_deal_id, hubspot_account_id, pylon_project_id, is_primary
       FROM deal_project_links
      WHERE hubspot_deal_id = $1 AND COALESCE(hubspot_account_id, '') = COALESCE($2, '')`,
    [hubspotDealId, hubspotAccountId]
  )
  return result.rows[0]
}

/** True if the deal already has a primary/anchor project (so we don't create a second anchor). */
export async function hasPrimaryLink(hubspotDealId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM deal_project_links WHERE hubspot_deal_id = $1 AND is_primary = TRUE LIMIT 1`,
    [hubspotDealId]
  )
  return result.rows.length > 0
}

export async function getLinkByProjectId(pylonProjectId: string): Promise<DealProjectLink | undefined> {
  const result = await db.query(
    `SELECT hubspot_deal_id, hubspot_account_id, pylon_project_id, is_primary
       FROM deal_project_links WHERE pylon_project_id = $1`,
    [pylonProjectId]
  )
  return result.rows[0]
}
