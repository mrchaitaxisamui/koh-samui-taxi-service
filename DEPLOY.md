# Mr Chai Dispatch – Deployment Guide

Complete Week 4: deploy the Cloudflare Worker, configure the Telegram bot, and connect the frontend.

---

## Prerequisites

- **Node.js** (v18+)
- **Wrangler** (Cloudflare CLI): `npm install -g wrangler` or `npx wrangler`
- **Cloudflare account** (free tier is enough)
- **Telegram bot** and **driver group chat ID** (see Telegram setup below)

---

## 1. Telegram bot setup

1. In Telegram, open [@BotFather](https://t.me/BotFather) and create a new bot: `/newbot`. Copy the **bot token** (e.g. `7123456789:AAH...`).
2. Create a **private group** for drivers and add your bot as a member (so it can post ride requests).
3. Get the **group chat ID**:
   - Add [@userinfobot](https://t.me/userinfobot) to the group, or
   - Send a message in the group, then open:  
     `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`  
     and find `"chat":{"id":-1234567890}`. The **id** is your `TELEGRAM_DRIVER_CHAT_ID` (negative number for groups).
4. Put the group chat ID in `wrangler.toml` under `[vars]`:
   ```toml
   [vars]
   TELEGRAM_DRIVER_CHAT_ID = "-1234567890"
   ```
   (Replace with your actual chat ID; the one in the file is an example.)

---

## 2. Cloudflare Worker deployment

### 2.1 Log in and KV namespace

```bash
# Log in (opens browser)
npx wrangler login

# KV namespace is already in wrangler.toml. If you ever need a new one:
# npx wrangler kv:namespace create RIDES
# Then set that id in wrangler.toml under [[kv_namespaces]]
```

### 2.2 Set the bot token (secret)

**Never commit the token.** Set it as a Wrangler secret:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Paste your bot token when prompted
```

### 2.3 Deploy the worker

```bash
npx wrangler deploy
```

Note the worker URL, e.g. `https://mrchai-dispatch.<your-subdomain>.workers.dev`.

### 2.4 Verify deployment

```bash
curl https://mrchai-dispatch.<your-subdomain>.workers.dev/api/health
```

You should get JSON: `{"ok":true,"service":"mrchai-dispatch",...}`.

---

## 3. Set Telegram webhook

After the worker is deployed, tell Telegram to send Accept/Decline callbacks to your worker:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://mrchai-dispatch.<your-subdomain>.workers.dev/api/telegram-webhook
```

Open that URL in a browser (or use `curl`). Response should include `"ok":true`.

**Check webhook:**

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

---

## 4. Connect the frontend

### 4.1 API base URL

In **index.html**, set `API_BASE` to your worker URL:

```javascript
var API_BASE = 'https://mrchai-dispatch.<your-subdomain>.workers.dev';
```

Replace `<your-subdomain>` with your actual Workers subdomain (e.g. `kohsamui-taxi` if your URL is `https://mrchai-dispatch.kohsamui-taxi.workers.dev`).

### 4.2 Google Maps API keys

**Frontend (map + address autocomplete)**  
The booking form uses the **Google Maps JavaScript API** with the **Places** library for the map and for Google’s native address autocomplete dropdown. Set your key in the frontend before the main script runs, for example in `index.html`:

```html
<script>window.__GOOGLE_MAPS_API_KEY = 'YOUR_KEY_HERE';</script>
```

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Maps JavaScript API** and **Places API**.
2. Create an API key and (optional) restrict it to your site’s domains (e.g. `https://yourdomain.com/*`).
3. If the key is not set, the form will show a console message and address autocomplete/map will not work.

**Worker (geocode for “Use my location”)**  
“Use my location” still uses the worker so the key stays server-side. Set the same or a second key as a Wrangler secret:

```bash
npx wrangler secret put GOOGLE_MAPS_API_KEY
```

1. Enable **Geocoding API** for the key used by the worker.
2. For server-side use, do **not** restrict that key to HTTP referrers. You can restrict by IP or leave unrestricted.

---

## 5. Host the frontend

Deploy `index.html`, `styles.css`, and assets (e.g. Mr Chai logo, Lottie JSON) to your host:

- **Cloudflare Pages**: connect the repo or upload the folder; the worker URL is independent.
- **Netlify / Vercel / any static host**: same; just ensure `API_BASE` in `index.html` points to the worker URL.

The site and the worker can be on different domains; CORS is already allowed by the worker.

---

## 6. Quick test

1. Open your live site, fill pickup, destination, and phone, submit.
2. In the driver Telegram group you should see “NEW RIDE REQUEST” with [Accept] [Decline].
3. Click **Accept** → the customer’s overlay should switch to “Driver on the way”.
4. Click **Decline** → the customer should see “No drivers available…”.

---

## Checklist

- [ ] Telegram bot created; token and driver group chat ID obtained
- [ ] `TELEGRAM_DRIVER_CHAT_ID` set in `wrangler.toml` `[vars]`
- [ ] `npx wrangler secret put TELEGRAM_BOT_TOKEN` run
- [ ] `npx wrangler deploy` run; worker URL noted
- [ ] `/api/health` returns `ok: true`
- [ ] Telegram webhook set to `.../api/telegram-webhook`
- [ ] `API_BASE` in `index.html` set to worker URL
- [ ] `npx wrangler secret put GOOGLE_MAPS_API_KEY` run (for address autocomplete & geocode)
- [ ] Frontend deployed; end-to-end test (request → Accept/Decline) done

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| “Dispatch API not configured” | `API_BASE` in index.html is set and matches the worker URL. |
| No Telegram message on ride request | Token set? `wrangler secret list` shows `TELEGRAM_BOT_TOKEN`. Chat ID correct and bot in group? |
| Accept/Decline does nothing in UI | Webhook set? `getWebhookInfo` shows your worker URL. Worker logs in Cloudflare dashboard. |
| 404 on /api/ride-request | Worker deployed? URL has no typo (e.g. trailing slash). |
| CORS errors | Worker sends CORS headers; ensure you’re not blocking mixed content if site is HTTPS and API is HTTPS. |

For worker logs: **Cloudflare Dashboard** → **Workers & Pages** → **mrchai-dispatch** → **Logs** (real-time or tail with `npx wrangler tail`).
