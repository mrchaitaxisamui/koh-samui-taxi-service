# Koh Samui Taxi service by Mr Chai

Website and lightweight dispatch for Koh Samui Taxi service by Mr Chai: booking form with address autocomplete, Cloudflare Worker backend, and Telegram notifications for drivers.

## What’s in this repo

- **Frontend**: `index.html`, `styles.css` – booking form (pickup/destination/phone), Google Maps API (map + Places autocomplete), loading overlay, success/decline/timeout states.
- **Backend**: `worker.js` – Cloudflare Worker with ride request API, KV state, and Telegram Accept/Decline.
- **Deploy**: See **[DEPLOY.md](./DEPLOY.md)** for step-by-step deployment and Telegram bot setup.

## Quick start (local)

1. Open `index.html` in a browser or serve the folder (e.g. `npx serve .`).
2. For live dispatch you must deploy the worker and set `API_BASE` in `index.html` (see DEPLOY.md).

## Tech

- **Maps & autocomplete**: Google Maps JavaScript API + Places API. Geocoding (e.g. “Use my location”) via worker-proxied Google Geocoding API.
- **Backend**: Cloudflare Workers + KV.
- **Notifications**: Telegram Bot API; drivers Accept/Decline in a group.

## AMP (Google Search)

An **Accelerated Mobile Pages** version of the homepage is available for fast, mobile-friendly indexing:

- **AMP page**: `index.amp.html` – valid AMP with hero, destinations, and CTAs (Book / WhatsApp). Full booking flow is on the canonical site.
- **Canonical link**: The main `index.html` includes `<link rel="amphtml" href="index.amp.html">` so Google can discover the AMP version.
- **Validate**: Run `npx amphtml-validator index.amp.html` locally, or after deploy use [Google’s AMP Test](https://search.google.com/test/amp) with your live URL (e.g. `https://mrchaitaxi.com/index.amp.html`).

## Files

| File        | Purpose |
|------------|---------|
| `index.html` | Main site and booking form script |
| `index.amp.html` | AMP version of homepage for Google Search |
| `styles.css` | Layout and component styles |
| `worker.js`  | Dispatch API and Telegram webhook |
| `wrangler.toml` | Worker config, KV binding, `TELEGRAM_DRIVER_CHAT_ID` |
| `Plan.md`   | Implementation plan and phase checklist |
| `DEPLOY.md` | Deployment and Telegram configuration guide |

## API (worker)

- `GET /` or `GET /api/health` – health check
- `POST /api/ride-request` – create ride, notify Telegram
- `GET /api/ride-status/:rideId` – poll status (pending | accepted | declined)
- `POST /api/telegram-webhook` – Telegram callback for Accept/Decline

See [DEPLOY.md](./DEPLOY.md) for deployment and testing.
