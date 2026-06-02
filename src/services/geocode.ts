const NOMINATIM = 'https://nominatim.openstreetmap.org/search'

export async function geocodeAddress(address: string): Promise<[number, number] | null> {
  // Normalise separators — HubSpot often stores addresses with semicolons
  const normalised = address.replace(/;/g, ',')
  const url = `${NOMINATIM}?q=${encodeURIComponent(normalised)}&format=json&limit=1&countrycodes=au`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hubspot-pylon-integration/1.0' },
  })
  if (!res.ok) return null

  const results = await res.json() as { lon: string; lat: string }[]
  if (!results.length) return null

  return [parseFloat(results[0].lon), parseFloat(results[0].lat)]
}
