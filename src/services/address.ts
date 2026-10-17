/**
 * Address check: turn whatever the customer typed (often a messy Facebook-form line) into a
 * standardised Pylon address + map pin, and grade how sure we are that it's the right house.
 *
 *   verified  every typed detail agrees with an exact house match → safe to push
 *   check     close, but something was guessed/corrected (pin estimated, suburb inferred, …)
 *   failed    no match, wrong number/state, conflicting postcode → never pushed to Pylon
 *
 * Google Geocoding is the primary lookup when GOOGLE_MAPS_API_KEY is set; OpenStreetMap
 * (Nominatim) is the fallback. Grading compares what was TYPED against what was MATCHED, so a
 * geocoder confidently returning the wrong place (e.g. "Jones St" → NSW) is caught.
 */
import { config } from '../config'
import { query as nominatimQuery, parseUnit, normalizeAddressLine, extractPostcode, cleanPostcode, type NominatimResult } from './geocode'

export type Grade = 'verified' | 'check' | 'failed'
export type Precision = 'exact' | 'estimated' | 'street' | 'area'

export interface AddressInput {
  street: string // street line without the unit; may still contain suburb/state/postcode text
  unit?: string
  suburb?: string
  state?: string
  postcodes: string[] // every postcode the customer gave, most trusted first
  source: string // where this came from, for the notes ("deal Pylon address fields", …)
}

export interface MatchedAddress {
  streetNumber?: string
  street?: string
  unit?: string
  suburb?: string
  state?: string
  postcode?: string
  lat: number
  lon: number
  precision: Precision
  provider: 'Google' | 'OpenStreetMap'
  partial?: boolean
}

export interface PylonAddressFields {
  line1: string
  unit: string
  suburb: string
  state: string
  postcode: string
}

export interface AddressCheck {
  grade: Grade
  notes: string[] // plain English, most important first
  match?: MatchedAddress
  fields: PylonAddressFields // what goes to Pylon (and pre-fills the deal fields)
  mapUrl?: string
}

// ---------- building the input ----------

const clean = (v?: string | null) => (v ?? '').trim() || undefined

/** From the raw HubSpot single-line install address plus any separate postcode fields. */
export function inputFromRaw(line: string, zips: (string | null | undefined)[], source: string): AddressInput {
  const tidy = line
    .replace(/([a-z])\.([a-z])/gi, '$1 $2') // "dr.hopper crossing" → "dr hopper crossing"
    .replace(/^(\s*\d+)\s+([a-z])\s+(?=[a-z]{3,})/i, '$1$2 ') // "57 b huntingfield" → "57b huntingfield"
  const { unit, street } = parseUnit(tidy)
  const postcodes = [extractPostcode(tidy), ...zips.map(cleanPostcode)].filter((p): p is string => !!p)
  return { street: normalizeAddressLine(street), unit, postcodes: [...new Set(postcodes)], source }
}

/** From the deal's Pylon address fields (pre-filled by a check, confirmed/edited by staff). */
export function inputFromFields(f: Partial<PylonAddressFields>, source: string): AddressInput {
  const { unit: lineUnit, street } = parseUnit(f.line1 ?? '')
  const postcode = cleanPostcode(f.postcode)
  return {
    street: normalizeAddressLine(street),
    unit: clean(f.unit)?.replace(/^(unit|u|apt|flat)\s*/i, '') ?? lineUnit,
    suburb: clean(f.suburb),
    state: clean(f.state),
    postcodes: postcode ? [postcode] : [],
    source,
  }
}

// ---------- providers ----------

const STATES: Record<string, string> = {
  victoria: 'VIC', 'new south wales': 'NSW', queensland: 'QLD', 'south australia': 'SA',
  'western australia': 'WA', tasmania: 'TAS', 'northern territory': 'NT', 'australian capital territory': 'ACT',
}
const stateAbbr = (s?: string) => (s ? STATES[s.toLowerCase()] ?? s.toUpperCase() : undefined)

async function google(q: string): Promise<MatchedAddress | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({
    address: q,
    components: 'country:AU',
    region: 'au',
    key: config.GOOGLE_MAPS_API_KEY!,
  })}`
  const res = await fetch(url)
  const body = (await res.json()) as any
  if (body.status === 'ZERO_RESULTS') return null
  if (body.status !== 'OK') throw new Error(`Google geocoding ${body.status}: ${body.error_message ?? ''}`)
  const r = body.results[0]
  const comp = (type: string, short = false) => {
    const c = r.address_components.find((x: any) => x.types.includes(type))
    return c ? (short ? c.short_name : c.long_name) : undefined
  }
  const streetNumber = comp('street_number')
  const street = comp('route')
  const type = r.geometry.location_type as string
  const precision: Precision =
    streetNumber && type === 'ROOFTOP' ? 'exact' : streetNumber ? 'estimated' : street ? 'street' : 'area'
  return {
    streetNumber,
    street,
    unit: comp('subpremise'),
    suburb: comp('locality') ?? comp('sublocality') ?? comp('postal_town'),
    state: comp('administrative_area_level_1', true),
    postcode: comp('postal_code'),
    lat: r.geometry.location.lat,
    lon: r.geometry.location.lng,
    precision,
    provider: 'Google',
    partial: !!r.partial_match,
  }
}

function fromNominatim(r: NominatimResult, typedNumber?: string): MatchedAddress {
  const a = r.address ?? {}
  const hn = a.house_number
  let precision: Precision = a.road ? 'street' : 'area'
  let streetNumber: string | undefined
  if (hn) {
    if (/[-,;]/.test(hn)) {
      // A range like "1-37" covers a whole block; only "estimated" even if it contains ours.
      precision = 'estimated'
      streetNumber = typedNumber && inRange(typedNumber, hn) ? typedNumber : hn
    } else {
      precision = 'exact'
      streetNumber = hn
    }
  }
  // Nominatim's `city` for metro addresses is "Melbourne", never the suburb: prefer the locality.
  const city = a.city && a.city !== 'Melbourne' ? a.city : undefined
  return {
    streetNumber,
    street: a.road,
    suburb: a.suburb || a.town || a.village || a.hamlet || a.locality || a.city_district || a.neighbourhood || city,
    state: stateAbbr(a.state),
    postcode: a.postcode,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    precision,
    provider: 'OpenStreetMap',
  }
}

async function openStreetMap(input: AddressInput, typedNumber?: string): Promise<MatchedAddress | null> {
  const base = [input.street, input.suburb, input.state].filter(Boolean).join(' ')
  const pc = input.postcodes[0]
  const queries = pc && !input.street.includes(pc) ? [`${base} ${pc}`, base] : [base]
  // Nominatim chokes on typos/junk in the suburb part ("doreen <IC", "cranboune"), so fall back
  // to just number + street, pinned down by the postcode.
  const { streetPart } = splitStreet(input.street)
  if (pc && streetPart !== input.street) queries.push(`${streetPart} ${pc}`)
  for (const q of queries) {
    const [r] = await nominatimQuery({ q: q.replace(/;/g, ',') }, 1)
    if (r) return fromNominatim(r, typedNumber)
  }
  return null
}

// ---------- comparison helpers ----------

const STREET_TYPES = new Set(
  ('st street rd road ave av avenue dr drive ct court cres crescent cct circuit cl close blvd bvd boulevard pl place ' +
    'ln lane pde parade tce terrace way gr grove hwy highway tr trail sq square esp esplanade rise loop mews walk row ' +
    'chase glade gdns gardens link vista view ridge track pkwy parkway crt cr drv blv ride wynd cove').split(' ')
)
const NOISE = new Set(
  ('vic victoria qld queensland nsw sa wa tas nt act au aus australia melbourne unit u apt flat lot').split(' ')
)

const tokens = (s?: string): string[] => (s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
const core = (s?: string) => tokens(s).filter((t) => !STREET_TYPES.has(t) && !NOISE.has(t) && !/^\d+[a-z]?$/.test(t))

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
const similar = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && editDistance(a, b) <= (b.length >= 7 ? 2 : 1))

function inRange(n: string, range: string): boolean {
  const num = parseInt(n, 10)
  return range.split(/[,;]/).some((part) => {
    const [lo, hi] = part.split('-').map((x) => parseInt(x, 10))
    return hi ? num >= lo && num <= hi : num === lo
  })
}

const sameNumber = (typed: string, found: string) => typed.toLowerCase() === found.toLowerCase() || inRange(typed, found)

/** The state an AU postcode belongs to (ACT ranges carved out of NSW's). */
function postcodeState(pc?: string): string | undefined {
  if (!pc) return undefined
  const n = parseInt(pc, 10)
  if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920) || (n >= 200 && n <= 299)) return 'ACT'
  if (n >= 800 && n <= 999) return 'NT'
  return { '1': 'NSW', '2': 'NSW', '3': 'VIC', '4': 'QLD', '5': 'SA', '6': 'WA', '7': 'TAS', '8': 'VIC', '9': 'QLD' }[pc[0]]
}

/** The state the customer gave: a state field, a state word in the line, or else their postcode. */
function typedState(input: AddressInput): string | undefined {
  if (input.state) return stateAbbr(input.state)
  const words = tokens(input.street)
  const named = ['vic', 'qld', 'nsw', 'sa', 'wa', 'tas', 'nt', 'act'].find((w) => words.includes(w))
  if (named) return named.toUpperCase()
  if (words.includes('victoria')) return 'VIC'
  if (words.includes('queensland')) return 'QLD'
  return postcodeState(input.postcodes[0])
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

/**
 * Split "43 Bassetts Rd, doreen <IC 3754" into the street ("43 Bassetts Rd") and the rest, at the
 * first street-type word after the street name. If there's no street-type word, it's all street.
 */
export function splitStreet(street: string): { streetPart: string; rest: string } {
  const words = street.split(/[\s,;]+/).filter(Boolean)
  const idx = words.findIndex((w, i) => i > 1 && STREET_TYPES.has(w.toLowerCase().replace(/[^a-z]/g, '')))
  if (idx === -1) return { streetPart: street.replace(/[,;]+$/, '').trim(), rest: '' }
  return { streetPart: words.slice(0, idx + 1).join(' '), rest: words.slice(idx + 1).join(' ') }
}

/** Best-effort suburb from the leftover text: drop state, postcode and junk characters. */
function suburbGuess(rest: string): string | undefined {
  const words = rest.split(/\s+/).filter((w) => /[a-z]/i.test(w) && !NOISE.has(w.toLowerCase().replace(/[^a-z]/g, '')))
  const cleaned = words.map((w) => w.replace(/[^a-z'-]/gi, '')).filter((w) => w.length > 2)
  return cleaned.length ? titleCase(cleaned.join(' ')) : undefined
}

// ---------- the check ----------

export async function checkAddress(input: AddressInput): Promise<AddressCheck> {
  const typedNumber = input.street.match(/^(\d+[a-z]?(?:-\d+[a-z]?)?)\b/i)?.[1]
  const query = [input.unit ? `${input.unit}/${input.street}` : input.street, input.suburb, input.state, input.postcodes[0]]
    .filter(Boolean)
    .join(', ')

  const notes: { level: Grade; text: string }[] = []
  const fail = (text: string) => notes.push({ level: 'failed', text })
  const warn = (text: string) => notes.push({ level: 'check', text })
  const info = (text: string) => notes.push({ level: 'verified', text })

  let match: MatchedAddress | null = null
  if (config.GOOGLE_MAPS_API_KEY) {
    try {
      match = await google(query)
    } catch (err) {
      info(`Google lookup unavailable (${(err as Error).message}), used OpenStreetMap instead.`)
    }
  }
  if (!match && input.street) match = await openStreetMap(input, typedNumber)

  const allowedStates = config.ADDRESS_ALLOWED_STATES.split(',').map((s) => s.trim().toUpperCase())

  if (!input.street) fail('No street address was entered.')
  else if (!match) fail("Couldn't find this address on the map.")
  if (input.street && !typedNumber) fail('The address has no street number.')

  if (match) {
    // The match must be in the state the customer gave (or their postcode's state); with nothing
    // given, in one of the states RevoluSun works in.
    const expected = typedState(input)
    if (match.state && expected && match.state !== expected) {
      fail(`The closest match is in ${match.state}, but the address given is in ${expected}, so it's probably the wrong place.`)
    } else if (match.state && !expected && !allowedStates.includes(match.state)) {
      fail(`The closest match is in ${match.state}, not ${allowedStates.join('/')}, so it's probably the wrong place.`)
    }
    if (typedNumber && match.streetNumber && !sameNumber(typedNumber, match.streetNumber)) {
      fail(`Street number doesn't match: typed ${typedNumber}, found ${match.streetNumber}.`)
    }
    if (match.precision === 'area') fail('Only the suburb was found, not the street.')
    if (match.precision === 'street' && typedNumber) warn(`Found the street but not number ${typedNumber}, so the pin is somewhere on the street. Check the pin.`)
    if (match.precision === 'estimated') warn('The house position is estimated along the street. Check the pin is on the right roof.')
    if (match.partial) warn('Google could only match part of what was typed.')

    // Street name: the matched road should be recognisably what was typed.
    const typedTokens = tokens(input.street)
    const roadCore = core(match.street)
    if (roadCore.length && !roadCore.every((t) => typedTokens.some((x) => similar(x, t)))) {
      warn(`Street matched as "${match.street}", which differs from what was typed.`)
    }

    // Suburb: whatever words are left after the number and street name.
    const leftover = [...core(input.street).filter((t) => !roadCore.some((r) => similar(t, r))), ...core(input.suburb)]
    const suburbCore = core(match.suburb)
    const suburbGiven = leftover.length > 0
    const suburbFull = suburbCore.length > 0 && suburbCore.every((t) => leftover.some((x) => similar(x, t)))
    const suburbSome = suburbCore.some((t) => leftover.some((x) => similar(x, t)))
    if (suburbFull && !suburbCore.every((t) => leftover.includes(t))) info(`Suburb spelling corrected to ${match.suburb}.`)
    if (suburbGiven && !suburbFull) {
      warn(suburbSome ? `Suburb matched as ${match.suburb}, slightly different from what was typed.` : `Typed suburb doesn't match the address found (${match.suburb}).`)
    }

    // Postcode: must agree with something the customer gave.
    const pcs = input.postcodes
    if (pcs.length && match.postcode) {
      if (pcs.includes(match.postcode)) {
        const others = pcs.filter((p) => p !== match!.postcode)
        if (others.length) warn(`Customer gave more than one postcode (${pcs.join(', ')}); ${match.postcode} matches the address.`)
      } else if (suburbFull) {
        warn(`Typed postcode ${pcs.join('/')} doesn't belong to ${match.suburb}; using ${match.postcode}.`)
      } else {
        fail(`Typed postcode ${pcs.join('/')} doesn't match the address found (${match.suburb ?? ''} ${match.postcode}).`)
      }
    } else if (!pcs.length && !suburbGiven) {
      warn(`No suburb or postcode was given, so ${match.suburb ?? 'the suburb'} was inferred. Confirm it's right.`)
    }
  }

  // Pylon rejects a project without a suburb: if neither the match nor the customer gave one, fail.
  const matchedSuburb = match?.suburb ?? input.suburb ?? suburbGuess(splitStreet(input.street).rest)
  if (match && !matchedSuburb) fail("The suburb couldn't be worked out from the address.")
  if (match && !match.suburb && matchedSuburb) warn(`The map didn't return a suburb, so "${matchedSuburb}" was taken from what was typed.`)

  const grade: Grade = notes.some((n) => n.level === 'failed') ? 'failed' : notes.some((n) => n.level === 'check') ? 'check' : 'verified'

  // Standardised fields: from the match where we have one, else what was typed (for staff to fix).
  const number = match?.streetNumber && typedNumber && /[-,;]/.test(match.streetNumber) ? typedNumber : match?.streetNumber ?? typedNumber
  const fields: PylonAddressFields =
    match && match.street && grade !== 'failed'
      ? {
          line1: `${number} ${match.street}`,
          unit: input.unit ?? match.unit ?? '',
          suburb: matchedSuburb ?? '',
          state: match.state ?? input.state ?? '',
          postcode: match.postcode ?? input.postcodes[0] ?? '',
        }
      : {
          line1: titleCase(splitStreet(input.street).streetPart),
          unit: input.unit ?? '',
          // Failed: pre-fill only what was TYPED, never details from a match we don't trust.
          suburb: input.suburb ?? suburbGuess(splitStreet(input.street).rest) ?? '',
          state: typedState(input) ?? '',
          postcode: input.postcodes[0] ?? '',
        }

  const order: Grade[] = ['failed', 'check', 'verified']
  const sorted = [...notes].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
  const icon = { failed: '❌', check: '⚠️', verified: 'ℹ️' }
  const lines = sorted.map((n) => `${icon[n.level]} ${n.text}`)
  if (match) lines.push(`Matched with ${match.provider} from the ${input.source}.`)

  return {
    grade,
    notes: lines,
    match: match ?? undefined,
    fields,
    mapUrl: match ? `https://www.google.com/maps/search/?api=1&query=${match.lat},${match.lon}` : undefined,
  }
}

export function formatAddress(f: PylonAddressFields): string {
  return `${f.unit ? `Unit ${f.unit}, ` : ''}${f.line1}, ${f.suburb} ${f.state} ${f.postcode}`.replace(/\s+/g, ' ').trim()
}
