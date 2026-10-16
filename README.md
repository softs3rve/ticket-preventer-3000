# ASP Ticket Preventer 3000 (New York City)

By **[softserve](https://github.com/softs3rve)**.

A reminder system for **New York City's Alternate Side Parking (ASP)**
street-cleaning rules. When you park, your phone reports the car's location.
A small Cloudflare Worker looks up the street-cleaning signs posted on that
block, works out when you next have to move, and warns you:

- a Discord message with a map as soon as you park
- a second Discord message 30 minutes before the cleaning window starts
- optionally, a **MOVE / SAFE** badge and a flashing **MOVE DA CAR** screen on
  a Spotify Car Thing (see [car-thing-projects](https://github.com/softs3rve/car-thing-projects)), or on
  any other device that can read JSON

> **NYC only.** It reads two City of New York open datasets (street
> centerlines and ASP sign locations) and NYC DOT's ASP suspension calendar.
> It will not find any signs anywhere else. Adapting it to another city means
> replacing those data sources, the sign-text parser, and the holiday list.

> **Advisory only.** This reads public sign data and parses the sign text
> automatically. It can be wrong (see [Limitations](#limitations)). Always
> read the actual sign on the block. Not affiliated with NYC DOT or the City
> of New York.

```
iPhone Shortcut ──POST /parking/report──▶ Cloudflare Worker ──▶ NYC Open Data
 (on CarPlay disconnect)                    │  stores last spot in KV
                                            ├──▶ Discord webhook (map + next cleaning)
                                            ├── cron every 5 min ──▶ Discord "move the car" alert
                                            └── GET /parking/status, /parking/map.svg
                                                 ◀── Car Thing / any display
```

---

## What you need

| Item | Required? | Notes |
|---|---|---|
| A car parked on NYC streets | yes | |
| [Cloudflare](https://dash.cloudflare.com/sign-up) account | yes | The free Workers plan is enough for one car. |
| [Node.js](https://nodejs.org) 18 or newer on a computer | yes | Only for deploying; nothing runs on your computer afterwards. |
| iPhone with the Shortcuts app | recommended | Anything that can send an HTTP POST with JSON works instead (Android automation apps, a script, etc.). CarPlay makes it automatic. |
| Discord server you control | recommended | Without it you get no push alerts; you'd have to look at a display. |
| Spotify Car Thing | optional | Only for the on-dash display. Needs the rest of this repo. |

---

## Step 1: Deploy the Worker

```bash
git clone https://github.com/softs3rve/ticket-preventer-3000
cd ticket-preventer-3000
npm install
npx wrangler login                          # opens a browser to sign in to Cloudflare
npx wrangler kv namespace create PARKING_KV # prints an id = "..." line
cp wrangler.toml.example wrangler.toml
```

Open `wrangler.toml` and paste the KV namespace id over
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Make a shared secret. Every request to the Worker must carry it.

```bash
openssl rand -hex 24                       # copy the output
npx wrangler secret put PARKING_SHARED_SECRET   # paste it when prompted
```

Keep that value somewhere safe (a password manager). You'll paste it into the
Shortcut and, if you use one, the Car Thing webapp.

Deploy:

```bash
npx wrangler deploy
```

Wrangler prints your Worker's URL, something like
`https://ticket-preventer-3000.<your-subdomain>.workers.dev`. That's your
**Worker URL** for the rest of this guide.

## Step 2: Test it from the command line

Use a test spot first, not your own. This one is a block on West 85th Street
in Manhattan that has posted ASP signs:

```bash
WORKER=https://ticket-preventer-3000.<your-subdomain>.workers.dev
SECRET=<your shared secret>

curl -X POST "$WORKER/parking/report" \
  -H "X-Parking-Secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"lat": 40.78632, "lon": -73.97372, "source": "curl-test"}'

curl "$WORKER/parking/status?key=$SECRET"
```

The first call returns the matched street and the signs it found (it can take
10 to 20 seconds; NYC Open Data is slow). The second returns `"status":
"SAFE"` or `"MOVE"` plus the parsed cleaning windows. Open
`$WORKER/parking/map.svg?key=$SECRET` in a browser to see the map.

If the first call returns a 500 error, NYC Open Data is probably having a
moment (it returns intermittent 500/503 errors). Wait a minute and retry.

## Step 3: Discord alerts (optional, recommended)

1. In your Discord server: **Server Settings → Integrations → Webhooks → New
   Webhook**. Pick the channel, then **Copy Webhook URL**.
2. Store it as a Worker secret:
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

No redeploy needed; secrets apply immediately. Re-run the test `report` call
from Step 2 and a message with a map should land in that channel.

Two kinds of message:

- **On every report:** `🚗 street between X and Y · side` and the next
  cleaning window, with a map image.
- **30 minutes before a cleaning window:** `⏰ Move the car`. Sent once per
  window by the cron trigger, which runs every 5 minutes. Skipped on ASP
  suspension days.

## Step 4: The iPhone Shortcut

This is what makes it automatic. It runs when your phone disconnects from
CarPlay, which is a good stand-in for "I just parked."

1. Open **Shortcuts → Automation → + (New Automation)**.
2. Choose **CarPlay → Disconnects**. Set it to **Run Immediately** so it
   doesn't ask each time.
3. Add the action **Get Current Location**.
4. Add the action **Get Contents of URL** and expand it (the arrow):
   - **URL:** `https://<your Worker URL>/parking/report`
   - **Method:** `POST`
   - **Headers:** add `X-Parking-Secret` with your shared secret as the value
   - **Request Body:** `JSON`, with three fields:

     | Key | Type | Value |
     |---|---|---|
     | `lat` | Number | the **Current Location** variable, tapped and set to **Latitude** |
     | `lon` | Number | the **Current Location** variable, set to **Longitude** |
     | `source` | Text | `shortcut` |

5. Save. Run it once by hand to check that the Discord message arrives.

`lat` and `lon` must be **Number** fields. If they're sent as text, the
Worker answers `400 lat/lon required`.

**No CarPlay?** Make the same shortcut as a regular (non-automation)
shortcut and run it from the home screen, a widget, the Action Button, or an
NFC tag in the car. Any other trigger the Shortcuts app offers works too.

**Android or something else?** Anything that can send this request works:

```
POST /parking/report
X-Parking-Secret: <secret>
Content-Type: application/json

{"lat": 40.78632, "lon": -73.97372, "source": "anything", "timestamp": 1760000000000}
```

`source` and `timestamp` (milliseconds since 1970) are optional.

## Step 5: Displays (optional)

- **Spotify Car Thing:** the Parking view (button 4) of
  [car-thing-projects](https://github.com/softs3rve/car-thing-projects/tree/main/car-thing-webapp). Set `PARKING_WORKER_BASE` and
  `PARKING_KEY` in its `index.html`. It polls `/parking/status`, shows the
  map, the cleaning schedule, and a SAFE/MOVE badge. In the hour before a
  window starts it switches to the Parking view from whatever view is up
  and shows a **MOVE DA CAR** alert; button 1 snoozes it for 15 minutes.
  The Car Thing needs an internet connection to reach the Worker; this
  repo's tested setup gets one through a Raspberry Pi (see
  [the Raspberry Pi gateway guide](https://github.com/softs3rve/car-thing-projects/blob/main/docs/02-raspberry-pi-gateway.md)).
- **Anything else** (an e-ink badge, a widget, a script): poll
  `/parking/status` as described below.

## Step 6: Once a year, update the holiday list

ASP is suspended on legal and religious holidays. The Worker carries a copy
of NYC DOT's published calendar in `parking.js`, in the
`ASP_SUSPENSION_DATES_2026` table. **It only covers 2026.** After that, every
day is treated as a normal enforcement day: you'll get warnings on holidays
too (annoying, but never a ticket).

When NYC DOT publishes the next year's calendar (search "NYC alternate side
parking calendar"), add the new dates in the same `'YYYY-MM-DD': 'Name'`
format and run `npx wrangler deploy` again.

---

## API reference

All routes require the shared secret, either as an `X-Parking-Secret` header
or a `?key=` query parameter. CORS is open (`Access-Control-Allow-Origin: *`)
so browser-based displays can call it; the secret is the only gate.

### `POST /parking/report`

Body: `{"lat": number, "lon": number, "source"?: string, "timestamp"?: number}`.
Finds the street, stores the result as the car's current spot (replacing the
previous one), posts to Discord. Returns `{ok, street, rules}`.

### `GET /parking/status`

```json
{
  "status": "SAFE",
  "moveNow": false,
  "moveInMinutes": null,
  "suspension": null,
  "record": {
    "lat": 40.78632, "lon": -73.97372, "timestamp": 1760000000000, "source": "shortcut",
    "street": {"streetName": "W  85 ST", "side": "N", "distanceMeters": 5.1, "physicalId": "4081"},
    "rules": [
      {"onStreet": "WEST 85 STREET", "fromStreet": "COLUMBUS AVENUE", "toStreet": "AMSTERDAM AVENUE",
       "side": "N", "description": "NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 8:30AM-10AM ...",
       "distanceMeters": 12, "windows": ["MON 8:30 AM–10 AM", "THU 8:30 AM–10 AM"]}
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `status` | `MOVE` if a cleaning window is active or starts within **8 hours** today and today isn't a suspension day; otherwise `SAFE`. `UNKNOWN` before the first report. |
| `moveNow` | `true` within **30 minutes** of a window (or during it). Use this for an urgent alert. |
| `moveInMinutes` | Minutes until the window starts (0 while it's running), only within **60 minutes**; otherwise `null`. |
| `suspension` | `{suspended, reason}` when it was checked (only when `status` would be `MOVE`); otherwise `null`. |
| `record` | The stored report, with each sign's parsed `windows`. |

### `GET /parking/map.svg`

An 800×480 SVG map of the streets around the car, with a pin labeled with
the street and side. Sized for the Car Thing screen.

---

## How it decides

1. **Which street.** Queries NYC's Centerline dataset for street segments
   within 500 m of the reported point and picks the segment closest to it.
   Which side of the street the car is on (N/S/E/W) comes from the segment's
   direction and which side of it the point falls on.
2. **Which signs.** Queries the ASP sign dataset for signs on that street
   name, converts each sign's coordinates (NY State Plane feet) to latitude
   and longitude, and keeps signs within 300 m.
3. **Which block and side.** Keeps signs on the car's side (falls back to
   both sides if none match), then only signs on the same block (same
   from/to cross streets) as the nearest sign.
4. **When.** Parses each sign's text, for example `TUESDAY FRIDAY
   11AM-12:30PM`, into weekly windows. Handles abbreviated days (`TUES`),
   `EXCEPT SUNDAY`, `NOON`/`MIDNIGHT`, `TO` as a separator, and a missing
   AM/PM on the first time.
5. **Whether it counts today.** Checks the holiday table. All times are New
   York time.

Sign rules are always fetched live (schedules change). Street geometry for
the map is cached for a day.

## Limitations

- **Read the sign.** Data can be out of date, a sign can be missing from the
  dataset, and the parser can misread unusual sign text. When it can't read
  a time it says so ("verify manually") rather than claiming the block is
  clear, but a sign that's missing from the data entirely looks the same as
  "no rule."
- **No emergency suspensions.** Only the planned calendar is known. Snow and
  other same-day suspensions aren't, so it will still tell you to move.
- **Corners are hard.** Phone GPS can be off by 10 m or more. Parked near an
  intersection, it can match the cross street. The Discord message and map
  name the matched street so you can catch this.
- **One car.** It stores one "current spot." Two cars need two Workers.
- **NYC Open Data outages.** The City's API returns intermittent 500/503
  errors. If the street lookup fails, the report fails (the Shortcut gets an
  error, nothing is stored), so re-run it. If only the sign lookup fails,
  the spot is stored with no signs and Discord says "No ASP signs matched
  this block, verify manually." Re-run the Shortcut in that case too.
- **Known issue: blank map after an outage.** If the street-geometry query
  fails, the map caches an empty background for that spot for a day. The
  pin, street label, and rules are unaffected. The fix is to skip caching
  when the query fails, in `fetchNearbyStreetRows` in `parking.js`.
- **The secret travels in URLs** for the `GET` routes (`?key=`), so it can
  show up in logs. It's a low-stakes secret (it protects your car's last
  location), but treat it like a password and rotate it with
  `wrangler secret put` if it leaks.
- **Holiday table expires** at the end of 2026 (see Step 6).

## Cost

On Cloudflare's free plan: the cron trigger runs about 8,600 times a month
and each report is a handful of requests, well inside the free limits. KV
writes happen only on reports and on each alert.

## Credits

- NYC Open Data: [Centerline](https://data.cityofnewyork.us/d/inkn-q76z)
  (Office of Technology and Innovation) and [Alternate Side Parking signs
  locations](https://data.cityofnewyork.us/d/2x64-6f34) (NYC DOT), via the
  Socrata API. NYC DOT's published ASP suspension calendar.
- [resvg-js / @resvg/resvg-wasm](https://github.com/yisibl/resvg-js)
  (MPL-2.0) rasterizes the map for Discord.
- [Carlito](https://github.com/googlefonts/carlito) (SIL Open Font License
  1.1), bundled as `assets/map-font.bin`, license in `assets/OFL.txt`.
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) and
  Workers KV; [wrangler](https://github.com/cloudflare/workers-sdk) (MIT or
  Apache-2.0) deploys it.
- Discord webhooks for the alerts.

Part of [car-thing-projects](https://github.com/softs3rve/car-thing-projects),
which has the Car Thing display and full credits for that side.

Not affiliated with NYC DOT, the City of New York, Cloudflare, or Discord.

## License

MIT, copyright softserve. See [LICENSE](LICENSE). The bundled Carlito font
is under the SIL Open Font License (`assets/OFL.txt`).
