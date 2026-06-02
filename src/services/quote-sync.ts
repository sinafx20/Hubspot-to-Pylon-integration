import { getPrimaryDesign, type PylonDesign, type PylonLineItem } from './pylon'
import {
  getAssociatedContact,
  getAssociatedCompany,
  overwriteDealLineItems,
  updateDealProperties,
  createNote,
  getEnumOptionValues,
  type DealLineItem,
} from './hubspot'

const centsToDollars = (cents: number): number => Math.round((cents / 100) * 100) / 100

// Strip Pylon's leading em-dash/bullet prefixes (e.g. "— Network pre-approval")
const cleanName = (desc: string): string => desc.replace(/^[—\-\s]+/, '').trim()

/** Run an enrichment step in isolation — a failure is logged but never aborts the other steps. */
async function safeStep(step: string, dealId: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`[quote-sync] ${step} failed for deal ${dealId}: ${(err as Error).message}`)
  }
}

/**
 * Map a Pylon component description to a valid HubSpot dropdown option value.
 * The brand fields are enumerations, so an unmatched value would be rejected by HubSpot.
 * We match the longest option value that appears in the description (handles multi-word
 * brands like "JA Solar" / "Canadian Solar"). Returns undefined if nothing matches — in
 * which case we simply don't set the field (better blank than wrong/erroring).
 */
async function resolveBrand(description: string | undefined, propertyName: string): Promise<string | undefined> {
  if (!description) return undefined
  let options: string[]
  try {
    options = await getEnumOptionValues('deals', propertyName)
  } catch {
    return undefined
  }
  const d = description.toLowerCase()
  return options
    .filter((o) => o && o.toLowerCase() !== 'other' && d.includes(o.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0]
}

/** Customer-visible, priced product/service lines only (excludes hidden, $0/bundled, and rebate/STC lines). */
function toLineItems(design: PylonDesign): DealLineItem[] {
  return design.line_items
    .filter(
      (li) =>
        !li.is_line_hidden &&
        li.included_in_summary_line === 'subtotal' &&
        li.total_amount != null &&
        li.total_amount > 0
    )
    .map((li) => {
      const qty = li.quantity ?? 1
      const unitCents = li.unit_amount ?? li.total_amount! / (qty || 1)
      return { name: cleanName(li.description), quantity: qty, price: centsToDollars(unitCents) }
    })
}

const findLine = (design: PylonDesign, re: RegExp): PylonLineItem | undefined =>
  design.line_items.find((li) => re.test(li.description))

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency.toUpperCase() }).format(
      cents / 100
    )
  } catch {
    return `$${centsToDollars(cents).toFixed(2)} ${currency.toUpperCase()}`
  }
}

/**
 * Best-effort enrichment of a HubSpot deal from the Pylon proposal/design:
 *  - overwrite deal line items with customer-visible priced lines
 *  - populate system-spec properties (kW, panels, brands, battery)
 *  - populate STC/rebate properties
 *  - log an activity note (with Pylon proposal links) on deal + contact + company
 *
 * Each step is isolated: one failing step does not block the others, and none of them
 * fail the (already-completed) deal stage move.
 */
export async function syncQuoteToDeal(dealId: string, pylonProjectId: string): Promise<void> {
  const design = await getPrimaryDesign(pylonProjectId)
  if (!design) return

  const [contact, company] = await Promise.all([
    getAssociatedContact(dealId),
    getAssociatedCompany(dealId),
  ])

  // 1. Line items — only overwrite when the proposal actually has priced lines, so a fully
  //    bundled proposal (no per-line prices) doesn't wipe the deal's existing line items.
  await safeStep('line items', dealId, async () => {
    const items = toLineItems(design)
    if (!items.length) {
      console.warn(`[quote-sync] No priced line items in proposal for deal ${dealId} — leaving existing line items untouched`)
      return
    }
    await overwriteDealLineItems(dealId, items)
  })

  // Resolve specs (brands mapped to valid dropdown options up front; safe to reuse in the note)
  const numberOfPanels = design.module_types.reduce((sum, m) => sum + (m.quantity ?? 0), 0)
  const panelBrand = await resolveBrand(design.module_types[0]?.description, 'panel_brand')
  const inverterBrand = await resolveBrand(design.inverter_types[0]?.description, 'inverter_brand')
  const batteryBrand = await resolveBrand(design.storage_types[0]?.description, 'battery_brand')

  // 2. System-spec properties
  await safeStep('spec properties', dealId, async () => {
    const specProps: Record<string, string | number> = {}
    if (design.summary.dc_output_kw != null) specProps.system_size_kw = design.summary.dc_output_kw
    if (design.summary.storage_kwh != null) specProps.battery_capacity_kwh = design.summary.storage_kwh
    if (numberOfPanels > 0) specProps.number_of_panels = numberOfPanels
    if (panelBrand) specProps.panel_brand = panelBrand
    if (inverterBrand) specProps.inverter_brand = inverterBrand
    if (batteryBrand) specProps.battery_brand = batteryBrand
    if (Object.keys(specProps).length) await updateDealProperties(dealId, specProps)
  })

  // 3. STC / rebate properties
  const stcLine = findLine(design, /\bstc/i)
  const rebateLine = findLine(design, /rebate/i)
  const loanLine = findLine(design, /loan/i)

  const stcProps: Record<string, string | number> = {}
  if (stcLine?.quantity != null) stcProps.of_stcs = stcLine.quantity
  if (stcLine?.total_amount != null) stcProps.stc_rebate_value = centsToDollars(Math.abs(stcLine.total_amount))
  if (rebateLine?.total_amount != null)
    stcProps.solarvic_rebate_amount = centsToDollars(Math.abs(rebateLine.total_amount))
  if (loanLine?.total_amount != null)
    stcProps.interest_free_loan_amount = centsToDollars(Math.abs(loanLine.total_amount))

  await safeStep('STC properties', dealId, async () => {
    if (Object.keys(stcProps).length) await updateDealProperties(dealId, stcProps)
  })

  // 4. Activity note
  await safeStep('activity note', dealId, async () => {
    await createNote(buildNoteBody(design, { numberOfPanels, panelBrand, inverterBrand, batteryBrand, stcProps }), {
      dealId,
      contactId: contact?.id,
      companyId: company?.id,
    })
  })
}

function buildNoteBody(
  design: PylonDesign,
  extra: {
    numberOfPanels: number
    panelBrand?: string
    inverterBrand?: string
    batteryBrand?: string
    stcProps: Record<string, string | number>
  }
): string {
  const s = design.summary
  const lines: string[] = ['<strong>Pylon quote sent</strong>']

  if (s.description) lines.push(`System: ${s.description}`)
  if (s.dc_output_kw != null) lines.push(`Size: ${s.dc_output_kw} kW`)
  if (extra.numberOfPanels > 0)
    lines.push(`Panels: ${extra.numberOfPanels}${extra.panelBrand ? ` × ${extra.panelBrand}` : ''}`)
  if (extra.inverterBrand) lines.push(`Inverter: ${extra.inverterBrand}`)
  if (extra.batteryBrand || (s.storage_kwh ?? 0) > 0)
    lines.push(`Battery: ${extra.batteryBrand ?? ''} ${s.storage_kwh ? `(${s.storage_kwh} kWh)` : ''}`.trim())
  if (design.pricing) lines.push(`Total: ${formatMoney(design.pricing.total, design.pricing.currency)} (inc GST)`)

  if (extra.stcProps.of_stcs != null) lines.push(`# of STCs: ${extra.stcProps.of_stcs}`)
  if (extra.stcProps.solarvic_rebate_amount != null) lines.push(`Solar VIC rebate: $${extra.stcProps.solarvic_rebate_amount}`)
  if (extra.stcProps.interest_free_loan_amount != null)
    lines.push(`Interest-free loan: $${extra.stcProps.interest_free_loan_amount}`)

  const links: string[] = []
  if (s.web_proposal_url) links.push(`<a href="${s.web_proposal_url}">View proposal</a>`)
  if (s.pdf_proposal_url) links.push(`<a href="${s.pdf_proposal_url}">Download PDF</a>`)
  if (links.length) lines.push(links.join(' &nbsp;|&nbsp; '))

  return lines.join('<br>')
}
