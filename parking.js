// "Ticket Preventer 3000" — NYC alternate-side-parking (ASP) avoidance.
//
// Flow: an iOS Shortcut (or the AirTag/FindMy.py fallback) POSTs the car's
// last-parked location here. We reverse-geocode it against NYC's live
// Centerline dataset to find the actual street segment, cross-reference
// that against the ASP-signs dataset for the posted rule(s) on that block,
// store the result, and notify Discord. The Car Thing and MagTag then pull
// status from here independently.
//
// Data sources (both live NYC Open Data / Socrata):
//   - Centerline (inkn-q76z): real street polyline geometry, already
//     WGS84 lat/lon, for both the reverse-geocode and the map SVG. The
//     reverse-geocode call (findNearestStreet) stays uncached — it feeds
//     which block's rules apply, so it must always reflect a fresh query.
//     The map-SVG call (fetchNearbyStreetRows) IS cached for a day — it
//     only draws background road lines, and geometry doesn't change day to
//     day, so caching it removes an external API round trip from the Car
//     Thing/MagTag's map load without affecting correctness anywhere.
//   - ASP signs (2x64-6f34): posted-rule text per block/side, always
//     queried live — a posted schedule can change, and this is what
//     actually decides "is it safe to park here," so it's never cached.
//     Coordinates on THIS dataset are NY State Plane feet (EPSG:2263) —
//     converted below, do not compare directly against lat/lon.

import { Resvg, initWasm } from '@resvg/resvg-wasm';
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';
// Carlito (OFL-licensed, Calibri-metric-compatible) — resvg-wasm has no
// filesystem access to system fonts in the Workers sandbox, so without an
// explicitly embedded font every <text> element in the SVG silently
// renders as nothing. assets/map-font.bin is Carlito Regular, renamed.
import MAP_FONT from './assets/map-font.bin';

// Rasterizes the map SVG to PNG for Discord, which doesn't render inline
// SVG previews. `initWasm` throws if called twice — the flag below tracks
// this Worker instance across requests (module scope survives between
// invocations on a warm isolate, but not a fresh one, hence the guard
// rather than assuming it only ever runs once).
let resvgWasmReady = false;
async function ensureResvgWasm() {
  if (!resvgWasmReady) {
    await initWasm(RESVG_WASM);
    resvgWasmReady = true;
  }
}

async function svgToPng(svgString) {
  await ensureResvgWasm();
  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: MAP_WIDTH },
    font: {
      loadSystemFonts: false,
      fontBuffers: [new Uint8Array(MAP_FONT)],
      defaultFontFamily: 'Carlito',
    },
  });
  return resvg.render().asPng();
}

const CENTERLINE_ENDPOINT = 'https://data.cityofnewyork.us/resource/inkn-q76z.json';
const ASP_SIGNS_ENDPOINT = 'https://data.cityofnewyork.us/resource/2x64-6f34.json';

const STATUS_KEY = 'last-status';
// Dedupe key for the scheduled Discord alert below — records which specific
// weekly occurrence (date + day + start time) was last alerted on, so a
// Cron Trigger running every few minutes sends exactly one notification per
// cleaning window instead of one per tick for the whole approach-and-active
// span.
const LAST_ALERT_KEY = 'last-alert';

const DISCORD_CONTENT_LIMIT = 2000;

// The two City datasets spell the same street differently: Centerline
// abbreviates the suffix ("... BLVD", "... AVE") while the ASP sign dataset
// usually writes it out ("... BOULEVARD", "... AVENUE"). Both also
// pad with runs of spaces ("WEST  100 STREET"). Normalizing to one canonical
// spelling is what lets a Centerline match find its own signs at all.
const STREET_SUFFIXES = {
  AVE: 'AVENUE', AV: 'AVENUE', ST: 'STREET', RD: 'ROAD', BLVD: 'BOULEVARD',
  PL: 'PLACE', PKWY: 'PARKWAY', EXPY: 'EXPRESSWAY', DR: 'DRIVE', LN: 'LANE',
  CT: 'COURT', BRG: 'BRIDGE', BRDG: 'BRIDGE', TER: 'TERRACE', TPKE: 'TURNPIKE',
  HWY: 'HIGHWAY', CONC: 'CONCOURSE', TRL: 'TRAIL', TUNL: 'TUNNEL',
  CIR: 'CIRCLE', PLZ: 'PLAZA', FWY: 'FREEWAY', PROM: 'PROMENADE',
  CRES: 'CRESCENT', ESPL: 'ESPLANADE', SQ: 'SQUARE', HL: 'HILL', GRN: 'GREEN',
  LK: 'LAKE', ALY: 'ALLEY', BDWK: 'BOARDWALK', VLG: 'VILLAGE', HTS: 'HEIGHTS',
  CV: 'COVE', XING: 'CROSSING', GDNS: 'GARDENS', RDG: 'RIDGE',
  CMNS: 'COMMONS', GLN: 'GLEN', EST: 'ESTATE', MNR: 'MANOR',
  DRWY: 'DRIVEWAY', RDWY: 'ROADWAY', STWY: 'STAIRWAY', TRWY: 'THROUGHWAY',
  CRSE: 'COURSE',
};
const STREET_DIRECTIONALS = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST' };

function normalizeStreetName(raw) {
  if (!raw) return '';
  const parts = String(raw).toUpperCase().trim().split(/\s+/);
  if (!parts.length || !parts[0]) return '';
  if (STREET_DIRECTIONALS[parts[0]]) parts[0] = STREET_DIRECTIONALS[parts[0]];
  const last = parts.length - 1;
  if (last > 0 && STREET_SUFFIXES[parts[last]]) parts[last] = STREET_SUFFIXES[parts[last]];
  return parts.join(' ');
}

// ── Day/time-window parsing from sign_description free text, e.g.
// "NO PARKING (SANITATION BROOM SYMBOL) TUESDAY FRIDAY 11AM-12:30PM <->" or
// "...MONDAY MIDNIGHT-3AM...". Needed for the MagTag's "danger within the
// next hour" full-screen alert — a simple "is any rule posted on this
// block" check (the earlier placeholder) isn't enough; it has to actually
// know whether today/now is inside or approaching the posted window.
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
// Signs commonly abbreviate days (e.g. "TUES FRI" rather than "TUESDAY
// FRIDAY") — checked against the full ~195k-row dataset, mechanically:
// matching only full names left ~10.5k rows unparseable. \b-bounded so
// "MON" doesn't match inside an unrelated word.
const DAY_ALIASES = {
  SUNDAY: ['SUNDAY', 'SUN'],
  MONDAY: ['MONDAY', 'MON'],
  TUESDAY: ['TUESDAY', 'TUES', 'TUE'],
  WEDNESDAY: ['WEDNESDAY', 'WED'],
  THURSDAY: ['THURSDAY', 'THURS', 'THU'],
  FRIDAY: ['FRIDAY', 'FRI'],
  SATURDAY: ['SATURDAY', 'SAT'],
};
function dayMatches(text, day) {
  return DAY_ALIASES[day].some((alias) => new RegExp(`\\b${alias}\\b`).test(text));
}

// `inheritMeridiem` covers the common "9:30-11AM" shape, where the first
// time in a range has no AM/PM of its own and takes the second time's.
function parseTimeToken(token, inheritMeridiem) {
  const t = token.trim();
  if (t === 'MIDNIGHT') return { hour: 0, min: 0 };
  if (t === 'NOON') return { hour: 12, min: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  const meridiem = m[3] || inheritMeridiem;
  if (!meridiem) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  return { hour, min: m[2] ? parseInt(m[2], 10) : 0 };
}

// Returns [{day, startMin, endMin}, ...] — one entry per day this
// description applies to (a description often lists 2+ days sharing one
// time range, e.g. "TUESDAY FRIDAY 11AM-12:30PM").
//
// "EXCEPT" inverts the day list and must be handled separately: roughly 10.5k
// of the ~195k sign rows use it, and "7:30AM-8AM EXCEPT SUNDAY" means the
// rule runs Monday–Saturday, not on Sunday. Reading it as a plain day
// mention (the earlier behavior) inverted a 6-day-a-week cleaning rule into
// a Sunday-only one — i.e. it reported SAFE on exactly the days the street
// actually gets swept, which is the ticket this app exists to prevent.
function parseRuleWindows(description) {
  if (!description) return [];
  let desc = description.toUpperCase();
  // Data typo seen across ~48 rows of one reused sign design: "10A M"
  // instead of "10AM" — a stray space splitting the meridiem letters.
  // Only fires when that space is actually there, so well-formed "10AM"
  // is untouched.
  desc = desc.replace(/(\d)\s*([AP])\s+M\b/g, '$1$2M');
  const exceptAt = desc.indexOf('EXCEPT');
  const before = exceptAt === -1 ? desc : desc.slice(0, exceptAt);
  const after = exceptAt === -1 ? '' : desc.slice(exceptAt);
  const statedDays = DAY_NAMES.filter((d) => dayMatches(before, d));
  const excludedDays = DAY_NAMES.filter((d) => dayMatches(after, d));
  // Days named up front win; otherwise an EXCEPT-only sign covers every
  // other day of the week.
  const days = statedDays.length
    ? statedDays.filter((d) => !excludedDays.includes(d))
    : DAY_NAMES.filter((d) => !excludedDays.includes(d));
  // The first time in a range is allowed to omit AM/PM ("9:30-11AM"); the
  // second must always state it, both because that's what real signs do
  // and because it's what parseTimeToken borrows the first time's meridiem
  // from. "TO" is accepted alongside "-" — both appear on real signs.
  const timeMatch = desc.match(/(MIDNIGHT|NOON|\d{1,2}(?::\d{2})?(?:\s*(?:AM|PM))?)\s*(?:-|TO)\s*(MIDNIGHT|NOON|\d{1,2}(?::\d{2})?\s*(?:AM|PM))/);
  // With no EXCEPT clause and no day named, there is nothing to anchor a
  // weekly window to — bail rather than assume all seven days.
  if (!days.length || !excludedDays.length && !statedDays.length) return [];
  if (!timeMatch) return [];
  const endMeridiemMatch = timeMatch[2].match(/AM|PM/i);
  const start = parseTimeToken(timeMatch[1], endMeridiemMatch ? endMeridiemMatch[0] : null);
  const end = parseTimeToken(timeMatch[2], null);
  if (!start || !end) return [];
  const startMin = start.hour * 60 + start.min;
  let endMin = end.hour * 60 + end.min;
  if (endMin <= startMin) endMin += 24 * 60; // crosses midnight (e.g. 11PM-1AM) — not seen in samples yet, handled defensively
  return days.map((day) => ({ day, startMin, endMin }));
}

// Current day/time in America/New_York — Workers run in UTC by default, no
// implicit local timezone, so this has to be computed explicitly rather
// than trusting `new Date()`'s own getters (same lesson as the Clock app's
// device-timezone bug — don't trust ambient "current time" without
// converting deliberately).
function nowInNewYork() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: map.weekday.toUpperCase(),
    minutesSinceMidnight: (parseInt(map.hour, 10) % 24) * 60 + parseInt(map.minute, 10),
  };
}

// Two-tier warning: a calm "MOVE" badge shows a full 8 hours out (plenty of
// notice, no urgency), but the flashing full-screen takeover (Car Thing's
// modal, the MagTag's alert screen — both key off the same `moveNow` field)
// only fires 30 minutes out, so it's reserved for genuinely "do this now."
const MOVE_SOON_LEAD_MINUTES = 480; // 8 hours — drives the static MOVE/SAFE badge
const MOVE_URGENT_LEAD_MINUTES = 30; // 30 minutes — drives moveNow (MagTag's alert + the urgent flag)
// The Car Thing's own periodic reminder window — deliberately a separate
// constant from MOVE_URGENT_LEAD_MINUTES rather than widening that one, so
// this doesn't also change the MagTag's existing 30-minute alert timing.
// Drives `moveInMinutes` below, which the Car Thing uses to flash briefly
// every 15 minutes for the hour before the car needs to move, instead of
// one continuous takeover for the last 30 minutes.
const CAR_THING_FLASH_LEAD_MINUTES = 60;

// True if any rule is either currently active or starts within leadMinutes.
function isDangerWithin(rules, leadMinutes) {
  const now = nowInNewYork();
  for (const rule of rules) {
    for (const w of parseRuleWindows(rule.description)) {
      if (w.day !== now.day) continue;
      if (now.minutesSinceMidnight >= w.startMin - leadMinutes && now.minutesSinceMidnight < w.endMin) {
        return true;
      }
    }
  }
  return false;
}

// ── Citywide ASP suspension check (planned holidays only) ─────────────────
// A static copy of NYC DOT's own published yearly suspension calendar
// (nyc.gov/html/dot/downloads/pdf/asp-calendar-20XX.pdf) rather than a live
// API — the NYC 311 Public API needs a signup at api-portal.nyc.gov that
// wasn't going through (no confirmation email arriving), and this is the
// exact same authoritative source with zero external dependency at
// request-time. The tradeoff: this can't catch same-day emergency
// suspensions (snow, etc.), only the planned ones DOT publishes in advance
// — same "err toward warning to move" default applies to those.
// Update once a year from the new PDF when it's published.
const ASP_SUSPENSION_DATES_2026 = {
  '2026-01-01': "New Year's Day",
  '2026-01-06': "Three Kings' Day",
  '2026-01-19': "Martin Luther King, Jr.'s Birthday",
  '2026-02-12': "Lincoln's Birthday",
  '2026-02-16': "Washington's Birthday / Lunar New Year's Eve",
  '2026-02-17': 'Lunar New Year',
  '2026-02-18': 'Ash Wednesday / Losar (Tibetan New Year)',
  '2026-03-03': 'Purim',
  '2026-03-20': 'Idul-Fitr (Eid Al-Fitr)',
  '2026-03-21': 'Idul-Fitr (Eid Al-Fitr)',
  '2026-04-02': 'Holy Thursday / Passover',
  '2026-04-03': 'Good Friday / Passover',
  '2026-04-08': 'Passover (7th Day)',
  '2026-04-09': 'Passover (8th Day) / Holy Thursday (Orthodox)',
  '2026-04-10': 'Good Friday (Orthodox)',
  '2026-05-14': 'Solemnity of the Ascension',
  '2026-05-22': 'Shavuoth',
  '2026-05-23': 'Shavuoth',
  '2026-05-25': 'Memorial Day',
  '2026-05-27': 'Idul-Adha (Eid Al-Adha)',
  '2026-05-28': 'Idul-Adha (Eid Al-Adha)',
  '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day (observed)',
  '2026-07-04': 'Independence Day',
  '2026-07-23': "Tisha B'Av",
  '2026-08-15': 'Feast of the Assumption',
  '2026-09-07': 'Labor Day',
  '2026-09-12': 'Rosh Hashanah',
  '2026-09-13': 'Rosh Hashanah',
  '2026-09-21': 'Yom Kippur',
  '2026-09-26': 'Succoth',
  '2026-09-27': 'Succoth',
  '2026-10-03': 'Shemini Atzereth',
  '2026-10-04': 'Simchas Torah',
  '2026-10-12': 'Columbus Day',
  '2026-11-01': "All Saints' Day",
  '2026-11-03': 'Election Day',
  '2026-11-08': 'Diwali',
  '2026-11-11': 'Veterans Day',
  '2026-11-26': 'Thanksgiving Day',
  '2026-12-08': 'Immaculate Conception',
  '2026-12-25': 'Christmas Day',
};

function checkAspSuspendedToday() {
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); // en-CA -> YYYY-MM-DD
  const reason = ASP_SUSPENSION_DATES_2026[todayIso];
  if (!reason) return { suspended: false, reason: null, checkedAt: Date.now() };
  return { suspended: true, reason, checkedAt: Date.now() };
}

// Human-readable "TUE 11:00 AM–12:30 PM" strings from parseRuleWindows'
// {day, startMin, endMin} — the Car Thing display wants actual times, not
// the raw sign text (e.g. "NO PARKING (SANITATION BROOM SYMBOL) TUESDAY
// FRIDAY 11AM-12:30PM <->").
function minutesToClock(totalMin) {
  const m = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
  let hour = Math.floor(m / 60);
  const min = m % 60;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return min === 0 ? `${hour} ${ampm}` : `${hour}:${String(min).padStart(2, '0')} ${ampm}`;
}

function formatWindow(w) {
  return `${w.day.slice(0, 3)} ${minutesToClock(w.startMin)}–${minutesToClock(w.endMin)}`;
}

// Minutes from `now` until this weekly window next begins; 0 while it is
// already running. Wraps around the week, so a Monday window seen on Friday
// is ~3 days out rather than negative.
function minutesUntilWindow(w, now) {
  const dayDelta = (DAY_NAMES.indexOf(w.day) - DAY_NAMES.indexOf(now.day) + 7) % 7;
  if (dayDelta === 0) {
    if (now.minutesSinceMidnight >= w.startMin && now.minutesSinceMidnight < w.endMin) return 0;
    if (now.minutesSinceMidnight < w.startMin) return w.startMin - now.minutesSinceMidnight;
    return 7 * 1440 - now.minutesSinceMidnight + w.startMin; // already passed today
  }
  return dayDelta * 1440 + w.startMin - now.minutesSinceMidnight;
}

function formatLeadTime(mins) {
  if (mins <= 0) return 'happening now';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

// The soonest upcoming window across these rules, or null if none parse.
function nextWindow(rules) {
  const now = nowInNewYork();
  let best = null;
  for (const rule of rules) {
    for (const w of parseRuleWindows(rule.description)) {
      const mins = minutesUntilWindow(w, now);
      if (!best || mins < best.mins) best = { mins, window: w, rule };
    }
  }
  return best;
}

function requireSecret(request, env) {
  const url = new URL(request.url);
  const provided = request.headers.get('X-Parking-Secret') || url.searchParams.get('key');
  return provided && env.PARKING_SHARED_SECRET && provided === env.PARKING_SHARED_SECRET;
}

// CORS: the Car Thing webapp calls these endpoints with a plain cross-origin
// fetch() from a real browser (unlike curl/CircuitPython, which don't
// enforce CORS at all), so responses need Access-Control-Allow-Origin or
// Chromium silently blocks the JS from reading them. Safe to allow any
// origin here — access is gated by the shared-secret key, not same-origin
// policy or cookies.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── EPSG:2263 (NY State Plane, US survey feet) -> EPSG:4326 (WGS84) ───────
// Minimal Lambert Conformal Conic implementation — no external geo library
// available in the Workers runtime, so this is hand-rolled from the
// published NAD83 Long Island zone (FIPS 3104) parameters. Accurate to a
// few feet, more than enough for matching a sign to the correct block.
function statePlaneToWgs84(xFeet, yFeet) {
  const ftToM = 0.3048006096012192; // US survey foot
  const x = xFeet * ftToM;
  const y = yFeet * ftToM;

  // NAD83 / New York Long Island (ftUS), EPSG:2263 parameters
  const a = 6378137.0; // GRS80 semi-major axis
  const f = 1 / 298.257222101;
  const e2 = 2 * f - f * f;
  const e = Math.sqrt(e2);
  const lat0 = (40 + 10 / 60) * Math.PI / 180;
  const lon0 = -(74 + 0 / 60) * Math.PI / 180;
  const lat1 = (40 + 40 / 60) * Math.PI / 180;
  const lat2 = (41 + 2 / 60) * Math.PI / 180;
  const falseEasting = 984250.0 * 0.3048006096012192;
  const falseNorthing = 0;

  function m(lat) {
    return Math.cos(lat) / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  }
  function t(lat) {
    return Math.tan(Math.PI / 4 - lat / 2) /
      Math.pow((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat)), e / 2);
  }

  const m1 = m(lat1);
  const m2 = m(lat2);
  const t0 = t(lat0);
  const t1 = t(lat1);
  const t2 = t(lat2);
  const n = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = a * F * Math.pow(t0, n);

  const dx = x - falseEasting;
  const dy = rho0 - (y - falseNorthing);
  const rho = Math.sign(n) * Math.sqrt(dx * dx + dy * dy);
  const theta = Math.atan2(dx, dy);

  const tIso = Math.pow(rho / (a * F), 1 / n);
  let lat = Math.PI / 2 - 2 * Math.atan(tIso);
  // Iterate to refine (isometric -> geodetic latitude)
  for (let i = 0; i < 6; i++) {
    const sinLat = Math.sin(lat);
    lat = Math.PI / 2 - 2 * Math.atan(tIso * Math.pow((1 - e * sinLat) / (1 + e * sinLat), e / 2));
  }
  const lon = theta / n + lon0;

  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Distance (meters) from a point to a line segment, plus which side it's on.
// Returns { distance, side: 1 | -1 } — side is which side of the segment's
// direction vector the point falls on (cross-product sign, left = 1).
function pointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 > 0 ? (apx * abx + apy * aby) / abLen2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx, cy = ay + t * aby;
  const dx = px - cx, dy = py - cy;
  const cross = abx * apy - aby * apx;
  return { distance: Math.sqrt(dx * dx + dy * dy), side: cross >= 0 ? 1 : -1 };
}

// Converts a segment-relative side (1 | -1, from pointToSegment) into a
// compass letter. A street's "side" only means N/S for an E-W street and
// E/W for a N-S street, so this looks at the segment's own bearing (in
// lon/lat space) rather than assuming a fixed axis — an avenue and a cross
// street need opposite compass pairs even though pointToSegment's 1/-1 is
// computed the same way for both.
function sideToCompass(lon1, lat1, lon2, lat2, side) {
  const dEast = lon2 - lon1;
  const dNorth = lat2 - lat1;
  // Left-of-travel normal, in (east, north) components.
  let normalEast = -dNorth;
  let normalNorth = dEast;
  if (side === -1) {
    normalEast = -normalEast;
    normalNorth = -normalNorth;
  }
  return Math.abs(normalEast) >= Math.abs(normalNorth)
    ? (normalEast >= 0 ? 'E' : 'W')
    : (normalNorth >= 0 ? 'N' : 'S');
}

// Find the nearest Centerline street segment to a lat/lon point.
// Queries via Socrata's $where, then does the precise nearest-segment math
// locally on whatever comes back.
//
// BUG (found 2026-08-06 from a real mismatch — a car parked on one street
// was reported as being on the cross street instead): both within_box and within_circle
// require the segment's ENTIRE geometry to be contained in the shape, not
// just intersect it — confirmed by direct testing against this dataset. A
// segment with a vertex 21m from the query point (i.e. obviously the
// closest street) was silently excluded because its far end poked past a
// 150m box, while a segment that happened to fit entirely inside "won" by
// default despite being genuinely farther away (19m real distance vs the
// reported match). Radius testing against the real mismatch coordinates
// found the true-nearest segment only starts appearing once the query
// shape is >= ~250m; NYC blocks (and Centerline segments) run well past
// 150m often enough that the old radius was a real, recurring bug, not an
// edge case. Widened to 500m for real safety margin — the extra rows
// (~100 vs a handful) cost nothing meaningful, and correctness here comes
// from computing the true minimum distance across everything returned, so
// there's no downside to casting a wider net.
async function findNearestStreet(lat, lon) {
  const radiusMeters = 500;
  const where = `within_circle(the_geom, ${lat}, ${lon}, ${radiusMeters})`;
  const url = `${CENTERLINE_ENDPOINT}?$where=${encodeURIComponent(where)}&$limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Centerline query failed: ${res.status}`);
  const rows = await res.json();

  let best = null;
  for (const row of rows) {
    if (!row.the_geom || row.the_geom.type !== 'MultiLineString') continue;
    for (const line of row.the_geom.coordinates) {
      for (let i = 0; i < line.length - 1; i++) {
        const [lon1, lat1] = line[i];
        const [lon2, lat2] = line[i + 1];
        // Rough planar approx over a small area — fine at block scale.
        const r = pointToSegment(lon, lat, lon1, lat1, lon2, lat2);
        const distMeters = r.distance * 111320 * Math.cos((lat * Math.PI) / 180);
        if (!best || distMeters < best.distanceMeters) {
          best = {
            distanceMeters: distMeters,
            side: sideToCompass(lon1, lat1, lon2, lat2, r.side),
            streetName: row.full_street_name || row.stname_label || row.street_name,
            physicalId: row.physicalid,
          };
        }
      }
    }
  }
  return best;
}

// Look up posted ASP rules near a point, on a named street.
//
// Name-matching alone is not enough — a long avenue can span many
// neighborhoods, so a plain "on_street LIKE" match could return signs from
// a completely different, distant block sharing the same street name.
// Filters to signs within DISTANCE_LIMIT_M of the actual point, using the
// EPSG:2263->4326 conversion above, and returns them sorted nearest-first.
const DISTANCE_LIMIT_M = 300;

// Busy streets carry far more signs than one page: Broadway alone has 1247
// rows, 3 AVENUE 882, 5 AVENUE 553. The old $limit=200 silently truncated
// those to an arbitrary 200 citywide, so the nearby signs were usually not in
// the response at all and a major avenue reported "no signs found". Trimming
// the columns keeps that larger page cheap.
const ASP_SELECT_FIELDS =
  'on_street,from_street,to_street,side_of_street,sign_description,sign_x_coord,sign_y_coord';
const ASP_ROW_LIMIT = 2000;

async function findAspRules(streetName, lat, lon) {
  const target = normalizeStreetName(streetName);
  if (!target) return [];
  // Wildcards stand in for the space runs both datasets use; the exact
  // normalized comparison below is what actually enforces the street match,
  // so a loose pattern here can't pull in a same-prefix street (e.g. "5
  // AVENUE" vs "15 AVENUE").
  const pattern = target.split(' ').join('%');
  const where = `upper(on_street) like upper('${pattern.replace(/'/g, "''")}')`;
  const url =
    `${ASP_SIGNS_ENDPOINT}?$select=${encodeURIComponent(ASP_SELECT_FIELDS)}` +
    `&$where=${encodeURIComponent(where)}&$limit=${ASP_ROW_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const rows = await res.json();

  const nearby = [];
  for (const r of rows) {
    if (normalizeStreetName(r.on_street) !== target) continue;
    const x = Number(r.sign_x_coord);
    const y = Number(r.sign_y_coord);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const signPos = statePlaneToWgs84(x, y);
    const distanceMeters = haversineMeters(lat, lon, signPos.lat, signPos.lon);
    if (distanceMeters <= DISTANCE_LIMIT_M) {
      nearby.push({
        onStreet: normalizeStreetName(r.on_street),
        fromStreet: normalizeStreetName(r.from_street),
        toStreet: normalizeStreetName(r.to_street),
        side: r.side_of_street,
        description: r.sign_description,
        distanceMeters: Math.round(distanceMeters),
      });
    }
  }
  nearby.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return nearby;
}

// ── SVG map, in the same visual language as the Light/Clock apps
// (tool-system.css: near-black bg, #ff0066 accent, radius-0, hairline
// borders, Source Code Pro for labels) — 800x480 to match the Car Thing's
// screen. Not a photographic map tile; real street geometry drawn by hand
// from Centerline data, projected into local screen-space.
const MAP_WIDTH = 800;
const MAP_HEIGHT = 480;
const MAP_RADIUS_DEG = 0.006; // ~650m at NYC's latitude — a real neighborhood view, several blocks each way

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// generateMapSvg's only network I/O: a live query against NYC's Centerline
// dataset for every street segment within ~650m of the car, used purely to
// draw the background road layout. This was the slow part of loading the
// Car Thing/MagTag map image — an uncached external API round trip on every
// fetch. Unlike the ASP sign rules (which genuinely need to stay live —
// posted schedules can change, and that's what "no caching" in this file's
// header comment is about), road geometry doesn't move day to day, so it's
// safe to cache server-side. Rounded to ~11m (4 decimal places) so parking
// at the same spot again — the common case — reuses the cache; the car pin
// and labels drawn below always use the exact reported lat/lon regardless,
// so this never affects positional accuracy, only how fast the background
// streets show up.
const MAP_STREETS_CACHE_TTL_SECONDS = 60 * 60 * 24; // 1 day
async function fetchNearbyStreetRows(lat, lon) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://parking-map-cache.internal/streets/${lat.toFixed(4)},${lon.toFixed(4)}`
  );
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const where = `within_box(the_geom, ${lat + MAP_RADIUS_DEG}, ${lon - MAP_RADIUS_DEG}, ${lat - MAP_RADIUS_DEG}, ${lon + MAP_RADIUS_DEG})`;
  const url = `${CENTERLINE_ENDPOINT}?$where=${encodeURIComponent(where)}&$limit=300`;
  const res = await fetch(url);
  const rows = res.ok ? await res.json() : [];

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(rows), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${MAP_STREETS_CACHE_TTL_SECONDS}`,
      },
    })
  );
  return rows;
}

async function generateMapSvg(lat, lon, street) {
  const rows = await fetchNearbyStreetRows(lat, lon);

  // meters-per-degree at this latitude, for a local equirectangular-ish
  // projection — fine at this scale (a few hundred meters across).
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const metersToPx = (MAP_WIDTH * 0.42) / (MAP_RADIUS_DEG * mPerDegLon); // fit radius to ~42% of width
  const toScreen = (ptLat, ptLon) => {
    const dxM = (ptLon - lon) * mPerDegLon;
    const dyM = (ptLat - lat) * mPerDegLat;
    return {
      x: MAP_WIDTH / 2 + dxM * metersToPx,
      y: MAP_HEIGHT / 2 - dyM * metersToPx, // screen y grows downward, lat grows upward
    };
  };

  const streetLines = [];
  const labelsByName = new Map(); // dedupe: one label per street name, at its longest segment's midpoint
  for (const row of rows) {
    if (!row.the_geom || row.the_geom.type !== 'MultiLineString') continue;
    const name = row.full_street_name || row.stname_label || row.street_name || '';
    for (const line of row.the_geom.coordinates) {
      const pts = line.map(([plon, plat]) => toScreen(plat, plon));
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      streetLines.push(d);

      if (name) {
        const len = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
        const existing = labelsByName.get(name);
        if (!existing || len > existing.len) {
          const mid = pts[Math.floor(pts.length / 2)];
          labelsByName.set(name, { len, x: mid.x, y: mid.y });
        }
      }
    }
  }

  const carPos = toScreen(lat, lon);

  const streetPaths = streetLines
    .map((d) => `<path d="${d}" stroke="rgba(255,255,255,0.35)" stroke-width="2" fill="none"/>`)
    .join('');

  // Several streets' candidate label positions land close together (a dense
  // grid of blocks in a ~650m radius), so placing every one at its raw
  // midpoint reliably prints names on top of each other. Greedily place
  // longer (more prominent) streets first, nudge a colliding label up/down
  // through a few offsets, and drop it entirely rather than let it overlap
  // — an absent label is legible, a smeared one isn't.
  const LABEL_FONT_SIZE = 12;
  const LABEL_HEIGHT = 14;
  const estimateTextWidth = (s) => s.length * LABEL_FONT_SIZE * 0.6;
  const boxAt = (x, y, w) => ({
    x1: x - w / 2, x2: x + w / 2,
    y1: y - LABEL_HEIGHT / 2, y2: y + LABEL_HEIGHT / 2,
  });
  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

  // Reserve the space the car pin's own "CAR" / street-name labels occupy so
  // a nearby street label can't land on top of the pin either. The pin's
  // circle (r=16 outer ring) is reserved too: the car usually sits at or
  // near an intersection, which is exactly where two cross streets'
  // midpoints cluster, and without this both cross streets' names
  // printed straight across the pin (seen live on the Car Thing, 2026-09-29).
  const PIN_CLEARANCE = 20;
  const placedBoxes = [
    { x1: carPos.x - PIN_CLEARANCE, x2: carPos.x + PIN_CLEARANCE, y1: carPos.y - PIN_CLEARANCE, y2: carPos.y + PIN_CLEARANCE },
    boxAt(carPos.x, carPos.y + 32, 60),
    boxAt(carPos.x, carPos.y + 48, 160),
  ];

  const placedLabels = [...labelsByName.entries()]
    .filter(([name]) => name)
    .sort((a, b) => b[1].len - a[1].len)
    .flatMap(([name, pos]) => {
      const width = estimateTextWidth(name);
      // Vertical nudges first, then a step further out, then sideways - the
      // sideways slots matter for a street whose midpoint sits on the car
      // pin itself (a cross street through the intersection the car is at),
      // which would otherwise always be dropped once the pin is reserved.
      // Sideways slots are measured from the pin, not the label's own
      // midpoint, so they clear the pin whichever side the midpoint is on.
      const besidePin = width / 2 + PIN_CLEARANCE + 6;
      const offsets = [
        [0, 0], [0, LABEL_HEIGHT], [0, -LABEL_HEIGHT], [0, 2 * LABEL_HEIGHT], [0, -2 * LABEL_HEIGHT],
        [0, -3 * LABEL_HEIGHT], [0, 3 * LABEL_HEIGHT],
        [carPos.x + besidePin - pos.x, 0], [carPos.x - besidePin - pos.x, 0],
      ];
      for (const [dx, dy] of offsets) {
        const box = boxAt(pos.x + dx, pos.y + dy, width);
        const onCanvas = box.x1 >= 4 && box.x2 <= MAP_WIDTH - 4 && box.y1 >= 4 && box.y2 <= MAP_HEIGHT - 4;
        if (onCanvas && !placedBoxes.some((p) => overlaps(box, p))) {
          placedBoxes.push(box);
          return [{ name, x: pos.x + dx, y: pos.y + dy }];
        }
      }
      return []; // no free slot found near this street's midpoint — skip it
    });

  const labels = placedLabels
    .map(
      ({ name, x, y }) =>
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="rgba(255,255,255,0.55)" font-family="Carlito, 'Source Code Pro', ui-monospace, monospace" font-size="${LABEL_FONT_SIZE}" text-anchor="middle">${escapeXml(
          name
        )}</text>`
    )
    .join('');

  // Several street labels can sit near the pin at once (an avenue and its
  // cross streets), so "CAR" alone doesn't say which one the car is
  // actually on — name it explicitly under the pin instead.
  const carStreetLabel = street?.streetName ? normalizeStreetName(street.streetName) : null;
  const carSideLabel = street?.side ? ` · ${street.side} side` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}">
  <rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="#0b0b10"/>
  <rect x="1" y="1" width="${MAP_WIDTH - 2}" height="${MAP_HEIGHT - 2}" fill="none" stroke="rgba(255,255,255,0.35)"/>
  ${streetPaths}
  ${labels}
  <circle cx="${carPos.x.toFixed(1)}" cy="${carPos.y.toFixed(1)}" r="10" fill="#ff0066"/>
  <circle cx="${carPos.x.toFixed(1)}" cy="${carPos.y.toFixed(1)}" r="16" fill="none" stroke="#ff0066" stroke-width="2"/>
  <text x="${carPos.x.toFixed(1)}" y="${(carPos.y + 32).toFixed(1)}" fill="#ff0066" font-family="Carlito, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="1">CAR</text>
  ${
    carStreetLabel
      ? `<text x="${carPos.x.toFixed(1)}" y="${(carPos.y + 48).toFixed(1)}" fill="#ff0066" font-family="Carlito, 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="13" font-weight="700" text-anchor="middle">${escapeXml(carStreetLabel)}${escapeXml(carSideLabel)}</text>`
      : ''
  }
</svg>`;
}

async function handleMap(request, env) {
  if (!requireSecret(request, env)) {
    return new Response('unauthorized', { status: 401 });
  }
  const raw = await env.PARKING_KV.get(STATUS_KEY);
  if (!raw) {
    return new Response('no report yet', { status: 404 });
  }
  const record = JSON.parse(raw);
  let svg;
  try {
    svg = await generateMapSvg(record.lat, record.lon, record.street);
  } catch (err) {
    return new Response(`map generation failed: ${err.stack || err}`, { status: 500 });
  }
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

async function postDiscord(env, message, pngBytes) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  // Discord rejects content over 2000 chars outright, and a rejection here is
  // easy to miss because nothing downstream depends on it — clamp rather than
  // let a long report silently fail to post.
  const content =
    message.length > DISCORD_CONTENT_LIMIT
      ? `${message.slice(0, DISCORD_CONTENT_LIMIT - 20)}\n… (truncated)`
      : message;
  try {
    let res;
    if (pngBytes) {
      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({ content, embeds: [{ image: { url: 'attachment://map.png' } }] })
      );
      form.append('files[0]', new Blob([pngBytes], { type: 'image/png' }), 'map.png');
      res = await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
    } else {
      res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    }
    // A non-2xx here used to pass silently, since fetch only rejects on
    // network errors — log the status and body so the next failure is visible.
    if (!res.ok) {
      console.error(`Discord post rejected: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('Discord post failed:', err);
  }
}

async function handleReport(request, env) {
  if (!requireSecret(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const { lat, lon, timestamp, source } = body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return json({ error: 'lat/lon required' }, 400);
  }

  const street = await findNearestStreet(lat, lon);
  const rules = street
    ? await findAspRules(street.streetName, lat, lon)
    : [];

  // A block posts the same handful of signs over and over along its length
  // (a real report returned 24 rows that were only 4 distinct signs), and the
  // car only ever sits on one side of the street — so listing every sign is
  // both redundant and mostly about the opposite kerb. Narrow to the side the
  // car is actually on and report only the next window that applies to it.
  const carSide = street?.side;
  const sideRules = carSide ? rules.filter((r) => r.side === carSide) : [];
  // Falling back to both sides is deliberate: a missing side match should
  // under-report timing, never silently claim the block is clear.
  const sideScoped = sideRules.length ? sideRules : rules;
  // DISTANCE_LIMIT_M (300m) easily spans multiple blocks of the same street,
  // and adjacent blocks can have different sweep schedules — picking the
  // globally-soonest window across everything within that radius (the old
  // behavior) could report a neighboring block's time instead of the one
  // that actually covers where the car is parked, even though the
  // cross-street text below was already correctly using the nearest sign.
  // Narrow to the same block as the nearest sign before persisting, so both
  // this report and every later /parking/status read see the corrected set.
  const nearestSign = sideScoped[0];
  const relevant = nearestSign
    ? sideScoped.filter(
        (r) => r.fromStreet === nearestSign.fromStreet && r.toStreet === nearestSign.toStreet
      )
    : sideScoped;

  const record = {
    lat,
    lon,
    timestamp: timestamp || Date.now(),
    source: source || 'unknown',
    street,
    rules: relevant,
  };

  await env.PARKING_KV.put(STATUS_KEY, JSON.stringify(record));

  const upcoming = nextWindow(relevant);

  // Cross streets come from the nearest relevant sign, not from Centerline —
  // the Centerline dataset has no from_street/to_street columns at all, which
  // is why this line used to read "between undefined and undefined".
  const nearest = relevant[0];
  const block =
    nearest && nearest.fromStreet && nearest.toStreet
      ? ` between ${nearest.fromStreet} and ${nearest.toStreet}`
      : '';
  const sideNote = carSide ? ` · ${carSide} side` : '';
  const streetDesc = street
    ? `${normalizeStreetName(street.streetName)}${block}${sideNote}`
    : 'no street match found';

  let ruleDesc;
  if (!rules.length) {
    ruleDesc = 'No ASP signs matched this block — verify manually.';
  } else if (!upcoming) {
    ruleDesc = `${relevant.length} sign(s) found, but no readable time window — verify manually.`;
  } else {
    const scope = sideRules.length ? '' : ' (both sides — no side-specific sign)';
    ruleDesc = `**${formatWindow(upcoming.window)}** — ${formatLeadTime(upcoming.mins)}${scope}`;
  }

  let mapPng;
  try {
    const svg = await generateMapSvg(lat, lon, street);
    mapPng = await svgToPng(svg);
  } catch (err) {
    console.error('Map snapshot for Discord failed:', err.stack || err);
  }

  await postDiscord(
    env,
    `🚗 **${streetDesc}**\n🧹 Next cleaning: ${ruleDesc}`,
    mapPng
  );

  return json({ ok: true, street, rules });
}

async function handleStatus(request, env) {
  if (!requireSecret(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const raw = await env.PARKING_KV.get(STATUS_KEY);
  if (!raw) return json({ status: 'UNKNOWN', reason: 'no report received yet' });
  const record = JSON.parse(raw);
  // Two-tier: `status` (MOVE/SAFE) is the calm 8-hour-out badge; `moveNow`
  // is the urgent 30-minute-out flag that triggers the flashing full-screen
  // takeover on the MagTag. A suspended day (checked once, off the wider 8h
  // signal) suppresses both together.
  const soon = isDangerWithin(record.rules || [], MOVE_SOON_LEAD_MINUTES);
  const suspension = soon ? checkAspSuspendedToday() : null;
  const suspended = !!(suspension && suspension.suspended);
  const status = soon && !suspended ? 'MOVE' : 'SAFE';
  const moveNow = status === 'MOVE' && isDangerWithin(record.rules || [], MOVE_URGENT_LEAD_MINUTES);

  // Minutes until the danger window actually starts (0 once it's active) —
  // only computed within the Car Thing's own 1-hour flash window. Lets the
  // Car Thing space its alert into periodic bursts instead of one
  // continuous takeover.
  const withinFlashWindow = status === 'MOVE' && isDangerWithin(record.rules || [], CAR_THING_FLASH_LEAD_MINUTES);
  const upcoming = withinFlashWindow ? nextWindow(record.rules || []) : null;

  const rulesWithSchedule = (record.rules || []).map((r) => ({
    ...r,
    windows: parseRuleWindows(r.description).map(formatWindow),
  }));

  return json({
    status,
    moveNow,
    moveInMinutes: upcoming ? upcoming.mins : null,
    suspension,
    record: { ...record, rules: rulesWithSchedule },
  });
}

// Runs off a Cron Trigger (not a fetch route) so a missed MagTag/Car Thing
// glance doesn't turn into a ticket: /parking/report only re-checks the
// schedule when the Shortcut fires on a location *change*, so nothing else
// notices "the 30-minute mark just arrived" while the car sits still.
// Reuses the exact same MOVE_URGENT_LEAD_MINUTES threshold that already
// drives the MagTag/Car Thing's own urgent alert, so "urgent" means the same
// thing everywhere in this app.
export async function checkParkingAlert(env) {
  const raw = await env.PARKING_KV.get(STATUS_KEY);
  if (!raw) return;
  const record = JSON.parse(raw);
  const rules = record.rules || [];
  if (!rules.length) return;

  const upcoming = nextWindow(rules);
  if (!upcoming || upcoming.mins > MOVE_URGENT_LEAD_MINUTES) return;

  // Same holiday-suspension check the status badge uses — a suspended day
  // means the posted window isn't actually enforced, so nothing to alert on.
  const suspension = checkAspSuspendedToday();
  if (suspension.suspended) return;

  // Stable across repeated ticks through the same occurrence (both the
  // 30-minute approach and however long the window stays active), but
  // changes once NY rolls to a new calendar day — so next week's identical
  // day/time reads as a new occurrence rather than being silently skipped.
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const alertKey = `${todayIso}|${upcoming.window.day}|${upcoming.window.startMin}`;
  const lastAlertKey = await env.PARKING_KV.get(LAST_ALERT_KEY);
  if (lastAlertKey === alertKey) return;
  await env.PARKING_KV.put(LAST_ALERT_KEY, alertKey);

  const nearest = rules[0];
  const block =
    nearest && nearest.fromStreet && nearest.toStreet
      ? ` between ${nearest.fromStreet} and ${nearest.toStreet}`
      : '';
  const sideNote = record.street?.side ? ` · ${record.street.side} side` : '';
  const streetDesc = record.street
    ? `${normalizeStreetName(record.street.streetName)}${block}${sideNote}`
    : 'unknown location';

  let mapPng;
  try {
    const svg = await generateMapSvg(record.lat, record.lon, record.street);
    mapPng = await svgToPng(svg);
  } catch (err) {
    console.error('Map snapshot for parking alert failed:', err.stack || err);
  }

  await postDiscord(
    env,
    `⏰ **Move the car — ${streetDesc}**\n🧹 Cleaning ${formatWindow(upcoming.window)} — ${formatLeadTime(upcoming.mins)}`,
    mapPng
  );
}

export async function handleParkingRoute(request, env, url) {
  if (url.pathname === '/parking/report' && request.method === 'POST') {
    return handleReport(request, env);
  }
  if (url.pathname === '/parking/status' && request.method === 'GET') {
    return handleStatus(request, env);
  }
  if (url.pathname === '/parking/map.svg' && request.method === 'GET') {
    return handleMap(request, env);
  }
  return null; // not a parking route
}
