# Better Transit

Personal Saskatoon transit app. Reads the city's official GTFS + GTFS-realtime feeds directly (no scraping).

    npm start      # http://localhost:3000, downloads/refreshes the schedule itself (daily check)
    npm test

- **Pinned**: search a route ("60") or stop and pin it. Route cards show each live bus by direction with its next stop; stop cards show live countdowns ("scheduled" when no live prediction exists)
- **Plan**: earliest-arrival trip planner with transfers, live delays and cancellations applied, optional leave time. From/To accept addresses and places (Google Places autocomplete), stops, bus destinations, or a bus line (then pick a stop on it)
- **Map**: live buses drawn as fleet#/route circles with an arrow for direction of travel (from the feed's bearing); filter to all, your pins, or one route · **Alerts**: city service alerts, your routes first
- **Notifications**: tap the bell on a pinned arrival to get a push when that bus is N minutes away (Web Push, VAPID keys auto-generated in `data/`).
- **Commutes**: after planning a trip, tap "Alert me when to leave" to save it with days and hours. During that window the server re-plans every minute and pushes "Leave in N min" for the next bus (walk time included). They sync between devices like pins.
- **Reliability**: every tracked bus that passes a stop adds its final delay to `data/history.json` (per route, stop, weekday/weekend and hour). Once a slot has 5+ samples, arrivals say "usually 3 min late" or "late 40% of the time here".
- **Devices**: with a login set, the phone icon in the header lists every signed-in device and signs one out (its push alerts stop too). Each sign-in is its own session in `data/sessions.json`; changing the password still signs everyone out.
- Open on your phone: `http://<this-mac-LAN-IP>:3000` → Share → Add to Home Screen. The offline cache (service worker) only activates over HTTPS or localhost.

Feeds: https://saskatoontransit.ca/node/562

## Deployed (GCP free-tier VM)

Runs 24/7 on `ayo-vm-instance` (e2-micro, us-central1-c, project `project-63c42225-37ba-43f1-893`) as the `bettertransit` systemd service
behind Caddy (automatic HTTPS): **https://34-46-182-45.sslip.io**. The app has its own login page (`auth.js`): it checks the password against the bcrypt
hash in `LOGIN_HASH` (in `/etc/bettertransit.env`; make one with `caddy hash-password`) and sets a 400-day cookie. Not Caddy Basic Auth: iOS Home Screen
apps forget Basic Auth between launches and show a white screen. Changing the hash signs every device out. Locally `LOGIN_HASH` is unset, so there's no login.
Static IP `ayo-vm-ip` reserved; firewall rule `allow-web-80-443` (VM tag `web`); budget alert at CAD 5.

    ./deploy.sh                                   # ship local code + restart
    gcloud compute ssh ayo-vm-instance --zone=us-central1-c --project=project-63c42225-37ba-43f1-893
    journalctl -u bettertransit -f                # on the VM: logs

Push subscriptions and VAPID keys live in `~/bettertransit/data/` on the VM (separate from local ones). The VM is memory-tight (1 GB, ~0.5 GB swap in use).

## Address search (Google Places)

`search.js` uses Google Places (New) autocomplete when `GOOGLE_PLACES_KEY` is set, otherwise the free Photon (OSM) service, which is slower and flaky.
On the VM the key lives in `/etc/bettertransit.env` (root-only, loaded by the systemd unit). It's a restricted key (`bettertransit-places` in the GCP
project): Places API only, callable only from the VM's IP. Keystrokes share a session token with the final place lookup, so autocomplete itself isn't billed.
Locally the key isn't set (its IP restriction would reject calls), so local dev falls back to Photon.

## Icons

UI icons are [lucide](https://lucide.dev) inline SVGs, never emojis. Add one by writing `icon('name')` in `public/app.js` or `data-icon="name"`
in `public/index.html`, then run `npm run icons` to regenerate `public/icons-data.js` (only the icons used are copied from `lucide-static`).
