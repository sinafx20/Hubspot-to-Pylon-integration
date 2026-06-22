const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const UA = 'hubspot-pylon-integration/1.0'

// ---- single-line address parsing (HubSpot install_address is one free-text line) ----

// Some HubSpot records contain Arabic-Indic / Persian digits — normalise them to ASCII so the
// postcode/number parsing and Nominatim both understand them.
function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
}

// Split a leading unit / sub-dwelling off an address line, in ANY common AU format:
// "6/123 Main St", "U6/123", "U6 123 Main St", "Unit 6, 123 Main St", "Flat 6 123",
// "Apt 6/123", "Suite 6 123". Returns the unit token (e.g. "6" or "12B") and the remaining
// street part used for geocoding. The unit is kept so we can store it on the Pylon address —
// but it's removed before geocoding because Nominatim fails on "6/123 …" but matches "123 …".
export function parseUnit(raw: string): { unit?: string; street: string } {
  const s = asciiDigits(raw).trim()
  // keyword form: Unit/U/Flat/Apt/Apartment/Suite <n> [,/ -] <street>
  const kw = s.match(/^\s*(?:unit|u|flat|fl|apt|apartment|suite|ste)\s*\.?\s*(\d+[a-z]?)\b\s*[,/\-]?\s*(.+)$/i)
  if (kw && kw[2].trim()) return { unit: kw[1].toUpperCase(), street: kw[2].trim() }
  // slash form with no keyword: "<unit>/<streetNo> <street>"
  const slash = s.match(/^\s*(\d+[a-z]?)\s*\/\s*(\d+[a-z]?\s+.+)$/i)
  if (slash) return { unit: slash[1].toUpperCase(), street: slash[2].trim() }
  return { street: s }
}

// Normalise a street line for geocoding: ascii digits, and insert a space where a letter run
// abuts a digit run (a state/postcode mashed onto the suburb, e.g. "vic3029" → "vic 3029";
// the 3+-letter guard avoids splitting ordinals like "14th"). Tidies separators/whitespace.
export function normalizeAddressLine(raw: string): string {
  return asciiDigits(raw)
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d)([a-z]{3,})/gi, '$1 $2')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Find the AU postcode in a free-text address line. Takes the LAST standalone 4-digit run (a
// postcode sits at the end), tolerating a letter mashed against it ("vic3029"). Ignores a 4-digit
// run at the very start of the line — that's the house number (e.g. "2774 Fourteenth St"), not a
// postcode.
export function extractPostcode(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const s = asciiDigits(raw)
  const re = /(?<!\d)(\d{4})(?!\d)/g
  let m: RegExpExecArray | null
  let last: { val: string; idx: number } | undefined
  while ((m = re.exec(s))) last = { val: m[1], idx: m.index }
  if (!last || last.idx === 0) return undefined
  return last.val
}

// Normalise a structured postcode field (ascii digits, trimmed) to a 4-digit code, or undefined.
export function cleanPostcode(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const m = asciiDigits(raw).match(/\d{4}/)
  return m ? m[0] : undefined
}

export interface AddressParts {
  street?: string
  city?: string
  state?: string
  postcode?: string
}

export interface GeoCandidate {
  lon: number
  lat: number
  display: string // Nominatim's normalised, correctly-formatted address
  precision: 'rooftop' | 'suburb' | 'approximate'
  // Normalised address parts, used to backfill a blank HubSpot suburb/state/postcode
  // so Pylon (which requires non-empty city + zip) accepts the project.
  components: { city?: string; state?: string; postcode?: string }
}

interface NominatimResult {
  lon: string
  lat: string
  display_name: string
  address?: Record<string, string>
}

// Pull a human suburb/city out of Nominatim's address object (the key varies by locality —
// e.g. some AU suburbs come back under city_district or neighbourhood).
function pickCity(a: Record<string, string> = {}): string | undefined {
  return (
    a.suburb ||
    a.city ||
    a.town ||
    a.village ||
    a.municipality ||
    a.city_district ||
    a.neighbourhood ||
    a.hamlet ||
    a.locality ||
    a.county ||
    undefined
  )
}

// One raw call to Nominatim. Either structured params (street/city/...) OR a free-text `q`.
async function query(params: Record<string, string>, limit: number): Promise<NominatimResult[]> {
  const sp = new URLSearchParams({
    format: 'json',
    addressdetails: '1',
    limit: String(limit),
    countrycodes: 'au',
    ...params,
  })
  const res = await fetch(`${NOMINATIM}?${sp}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) return []
  return (await res.json()) as NominatimResult[]
}

// Structured geocoding is far more robust than a free-text blob, because Nominatim
// can match each component independently. We try most-precise first, then fall back
// to progressively coarser searches so a messy street still yields *something*.
// Returns ranked candidates; [0] is the best. Empty array = nothing found at all.
export async function searchCandidates(
  input: { parts?: AddressParts; free?: string },
  limit = 3
): Promise<GeoCandidate[]> {
  const { parts, free } = input

  // attempts run in order; first one with results wins
  const attempts: { params: Record<string, string>; precision: GeoCandidate['precision'] }[] = []

  if (parts) {
    const street = parts.street?.includes(';') ? parts.street.split(';')[0].trim() : parts.street
    // 1. full structured (street + suburb + state + postcode) → rooftop-ish
    const full: Record<string, string> = {}
    if (street) full.street = street
    if (parts.city) full.city = parts.city
    if (parts.state) full.state = parts.state
    if (parts.postcode) full.postalcode = parts.postcode
    if (full.street && (full.city || full.postalcode)) attempts.push({ params: full, precision: 'rooftop' })

    // 2. suburb + postcode only (drop the street) → suburb centroid, good enough for a pin
    const coarse: Record<string, string> = {}
    if (parts.city) coarse.city = parts.city
    if (parts.state) coarse.state = parts.state
    if (parts.postcode) coarse.postalcode = parts.postcode
    if (coarse.city || coarse.postalcode) attempts.push({ params: coarse, precision: 'suburb' })
  }

  // 3. last resort: free text, normalising HubSpot's semicolon separators
  if (free) attempts.push({ params: { q: free.replace(/;/g, ',') }, precision: 'approximate' })

  for (const { params, precision } of attempts) {
    const results = await query(params, limit)
    if (results.length) {
      return results.map((r) => ({
        lon: parseFloat(r.lon),
        lat: parseFloat(r.lat),
        display: r.display_name,
        precision,
        components: {
          city: pickCity(r.address),
          state: r.address?.state,
          postcode: r.address?.postcode,
        },
      }))
    }
  }
  return []
}

// Backwards-compatible helper: free-text address → coordinates (or null).
export async function geocodeAddress(address: string): Promise<[number, number] | null> {
  const candidates = await searchCandidates({ free: address }, 1)
  if (!candidates.length) return null
  return [candidates[0].lon, candidates[0].lat]
}
