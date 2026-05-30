import { db } from './index'

export async function saveLink(hubspotDealId: string, pylonProjectId: string) {
  await db.query(
    `INSERT INTO deal_project_links (hubspot_deal_id, pylon_project_id)
     VALUES ($1, $2)
     ON CONFLICT (hubspot_deal_id) DO UPDATE
       SET pylon_project_id = EXCLUDED.pylon_project_id,
           last_synced_at   = NOW()`,
    [hubspotDealId, pylonProjectId]
  )
}

export async function getLinkByDealId(hubspotDealId: string) {
  const result = await db.query(
    `SELECT * FROM deal_project_links WHERE hubspot_deal_id = $1`,
    [hubspotDealId]
  )
  return result.rows[0] as { hubspot_deal_id: string; pylon_project_id: string } | undefined
}

export async function getLinkByProjectId(pylonProjectId: string) {
  const result = await db.query(
    `SELECT * FROM deal_project_links WHERE pylon_project_id = $1`,
    [pylonProjectId]
  )
  return result.rows[0] as { hubspot_deal_id: string; pylon_project_id: string } | undefined
}
