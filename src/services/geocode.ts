const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const UA = 'hubspot-pylon-integration/1.0'

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
}

interface NominatimResult {
  lon: string
  lat: string
  display_name: string
  address?: Record<string, string>
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
