# Better Transit

Personal Saskatoon transit app. Reads the city's official GTFS + GTFS-realtime feeds directly (no scraping).

    npm start      # http://localhost:3000, downloads/refreshes the schedule itself (daily check)
    npm test

- **Pinned**: search a route ("60") or stop and pin it. Route cards show each live bus by direction with its next stop; stop cards show live countdowns ("scheduled" when no live prediction exists)
- **Plan**: earliest-arrival trip planner with transfers, live delays and cancellations applied, optional leave time. From/To accept addresses and places (Google Places autocomplete), stops, bus destinations, or a bus line (then pick a stop on it)
- **Map**: live buses drawn as fleet#/route circles with an arrow for direction of travel (from the feed's bearing); filter to all, your pins, or one route · **Alerts**: city service alerts, your routes first
- **Notifications**: tap the bell on a pinned arrival to get a push when that bus is N minutes away (Web Push, VAPID keys auto-generated in `data/`).
- **Commutes**: after planning a trip, tap "Alert me when to leave" to save it with days and hours. During that window the server re-plans every minute and pushes "Leave in N min" for the next bus (walk time included). They sync between devices like pins.
- **Riding**: on a planned trip, tap "I'm on this bus" on a ride leg to get "Your stop is next" a stop before you get off. If another bus follows, it also warns once when you'll miss the connection and re-plans from where you get off.
- **Last bus**: arrivals and ride legs are tagged when they're the last scheduled trip of the day on that route and direction; commute alerts add "last bus".
- **Plan from the map**: long-press the map for "Plan from here / to here" (named after a stop within 150 m, else "Dropped pin"). "Show on map" on a trip card draws it: dashed walks and each ride along its stops.
- **Stop settings**: tap a pinned stop's name to give it a nickname and choose which of its routes the card shows (and its bell alerts for). Both sync with the pins.
- **Riding extras**: with "I'm on this bus" on, the leg counts down ("4 stops to go · off at 5:12") and the screen stays awake (Wake Lock) until you get off. Stop cards' walk line opens walking directions in Maps.
- **Fullness**: when the city's feed reports it, live buses show Many seats / Few seats / Standing room next to the fleet number.
- **Accordion buses**: the feed only gives fleet numbers, so `fleet.js` lists the articulated (60 ft) batches. Live buses on those numbers show "Accordion", and so do later trips on the same block once that bus is out (the same bus will run them). Further ahead, runs that got an articulated bus on most past days show "Usually accordion" (learned in `data/history.json`). On the map they get a double ring. Add new batches to `fleet.js` when the city buys more.
- **What past days say about a run**: `runwatch.js` follows every scheduled run of the service day (it turns over at 3 AM, so after-midnight trips count for the day before) and, once a run is over, records in `data/history.json` whether it got an accordion bus, whether it was ever standing-room full, and whether a bus showed up at all (only while the vehicle feed was up the whole time; announced cancellations and a late bus still on its previous trip don't count). Arrivals and plan legs then say "Usually accordion", "Usually standing room" (until the live bus reports its fullness) or "No bus came on 40% of past days"; the planner puts a close alternative ahead of such a run.
- **Bus details everywhere**: plan ride legs, stop cards, route cards, the trip sheet and the map popup all show the fleet number, Accordion and fullness the same way. A later trip on a block whose bus is already out shows that bus even before it has a live prediction.
- **Bell countdown**: a bell on one bus notifies at your chosen minutes, again at 3 min, and when it's due. All three share one notification tag, so each replaces the last.
- **Siri & Shortcuts**: Alerts → "Siri & Shortcuts link" gives a URL for Shortcuts' "Get Contents of URL" (add Speak Text, or show it in a widget). `/api/say` returns one plain-text line per pinned stop ("Home: 27 in 4 min, 60 in 11 min (scheduled)."), or `?stop=ID` for one stop. With a login, the link carries its own key that works only for `/api/say`; it appears under the devices as "Siri & Shortcuts" and can be signed out there.
- **Follow my bus**: with "I'm on this bus" on, a navigation button on the map keeps your bus in view (it shows even when filtered out). Dragging the map stops following.
- **Plan shortcuts**: "Leave in 15 / 30 min / 1 h" chips, and Earlier / Later under the results. Anything that fails to load shows a Retry button.
- **Alerts on cards**: a pinned stop or route with a service alert on it shows a warning line under its name; tap it to read the notice. The Home Screen icon badge shows the same unseen count as the Alerts tab (the service worker adds one per alert push while the app is closed).
- **Recent trips**: an empty From/To box offers your last trips (From → To) first; one tap fills both and plans. "My location" re-locates you. Synced like recents.
- **Old data**: once data is over a minute old or you're offline, countdowns fade, lose the live dot, and the header says "as of 5:12". Opened offline, the app shows the arrivals the service worker cached last time (it tags them `x-cached`, so they're never shown as fresh).
- **Reorder**: in reorder mode, drag a stop by its grip (the arrows still move one step).
- **Text size**: font sizes are rem on `-apple-system-body`, so they follow the iPhone's Text Size setting (17px base elsewhere).
- **Timetable**: the calendar button on a stop card opens that stop's full day by route and headsign (Today, Tomorrow or any date); `/api/timetable/:stopId?date=YYYY-MM-DD`.
- **Reliability**: every tracked bus that passes a stop adds its final delay to `data/history.json` (per route, stop, weekday/weekend and hour). Once a slot has 5+ samples, arrivals say "usually 3 min late" or "late 40% of the time here".
- **Devices**: with a login set, the phone icon in the header lists every signed-in device and signs one out (its push alerts stop too). Each sign-in is its own session in `data/sessions.json`; changing the password still signs everyone out.
- **Ask**: the box at the top of Plan opens a chat ("when should I head home after 5:30?"). Gemini answers only from the app's own data, which it reads by calling tools (`chat.js`, tools in `server.js`): places, the planner, a departure-window comparison, live arrivals, timetables, buses on a route, alerts, weather, your pins/places/commutes. It can offer to pin a stop or route, set a bus alert or save a commute, but only as a button you tap. Needs `GEMINI_API_KEY` (optional `GEMINI_MODEL`, default `gemini-3.5-flash-lite`: fast, and its free-tier quota is roomier, since one question is several requests); the conversation lives on the phone until you close the sheet.
- Open on your phone: `http://<this-mac-LAN-IP>:3000` → Share → Add to Home Screen. The offline cache (service worker) only activates over HTTPS or localhost.

Feeds: https://saskatoontransit.ca/node/562

## Deployed (GCP free-tier VM)

Runs 24/7 on a GCP e2-micro VM as the `bettertransit` systemd service behind Caddy (automatic HTTPS). The app has its own login page (`auth.js`):
it checks the password against the bcrypt hash in `LOGIN_HASH` (in `/etc/bettertransit.env`; make one with `caddy hash-password`) and sets a 400-day
cookie. Not Caddy Basic Auth: iOS Home Screen apps forget Basic Auth between launches and show a white screen. Changing the hash signs every device out.
Locally `LOGIN_HASH` is unset, so there's no login. Set `PUSH_SUBJECT` to the app's public URL there too (Apple's push service wants a real contact).

The deploy target lives in `deploy.env` (gitignored), which `deploy.sh` reads:

    P=<gcp-project-id>
    Z=<zone>
    VM=<user>@<vm-name>

    ./deploy.sh                                   # ship local code + restart
    gcloud compute ssh <vm-name> --zone=<zone> --project=<gcp-project-id>
    journalctl -u bettertransit -f                # on the VM: logs

Push subscriptions and VAPID keys live in `~/bettertransit/data/` on the VM (separate from local ones). The VM is memory-tight (1 GB).

## Address search (Google Places)

`search.js` uses Google Places (New) autocomplete when `GOOGLE_PLACES_KEY` is set, otherwise the free Photon (OSM) service, which is slower and flaky.
On the VM the key lives in `/etc/bettertransit.env` (root-only, loaded by the systemd unit). It's a restricted key (`bettertransit-places` in the GCP
project): Places API only, callable only from the VM's IP. Keystrokes share a session token with the final place lookup, so autocomplete itself isn't billed.
Locally the key isn't set (its IP restriction would reject calls), so local dev falls back to Photon.

## Icons

UI icons are [lucide](https://lucide.dev) inline SVGs, never emojis. Add one by writing `icon('name')` in `public/app.js` or `data-icon="name"`
in `public/index.html`, then run `npm run icons` to regenerate `public/icons-data.js` (only the icons used are copied from `lucide-static`).
