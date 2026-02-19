# Booking Confirmation – Driver Name Feature

Feature spec and implementation notes for showing the accepting driver’s name on the confirmation page.

## Goal

When a driver accepts a ride in the Telegram group, the booking confirmation page shows **that driver’s name** so the customer knows who is picking them up. No customer selection—whoever accepts is who gets displayed.

## Approach (Option A)

- **Trigger:** Driver taps an Accept button (e.g. “✅ 15 min”) in Telegram.
- **Backend:** Telegram webhook receives `callback_query` with `from` (user who clicked). We derive a display name (e.g. Telegram `first_name` or first + last) and store it on the ride in KV.
- **API:** `GET /api/ride-status/:rideId` returns `driverName` when status is `accepted`.
- **Frontend:** `booking-confirmation.html` fetches ride status and shows “Your driver: [name]” and uses the name in “What happens next?” where appropriate.

## Data

- **KV ride object (add when accepted):**
  - `driverName` (string, optional): Display name of the driver who accepted (e.g. from Telegram `callback_query.from.first_name` and optional `last_name`).

- **Ride status response (add field):**
  - `driverName` (string | null): Present when `status === 'accepted'`.

## Driver display name

- **Source:** Telegram `callback_query.from` when a driver accepts.
- **Logic:** Use `first_name`; if `last_name` is present, use `"first_name last_name"`. Trim and fallback to `"Your driver"` if empty.
- **Optional later:** Map Telegram `from.id` to fixed display names (e.g. “Chai”, “Som”, “Wei”) via env/config if you want consistent branding instead of Telegram profile names.

## Files to change

| File | Change |
|------|--------|
| `worker.js` | In Telegram webhook, on accept: set `ride.driverName` from `cb.from`. In `handleRideStatus`, include `driverName` in response. |
| `booking-confirmation.html` | Add “Your driver” row; set text from `ride.driverName`. Optionally update “What happens next?” to mention driver by name. |

## Implementation checklist

- [x] Spec written in `bookingconfirmation-feature.md`
- [x] Worker: on accept, set `ride.driverName` from `cb.from.first_name` (+ `last_name` if present)
- [x] Worker: `handleRideStatus` returns `driverName` when present
- [x] Confirmation page: show “Your driver: [name]” (or hide row if no name)
- [x] Confirmation page: “What happens next?” uses driver name when present

## Driver phone (config mapping)

Driver phone numbers are **not** sent by Telegram when a driver accepts. We use a **config mapping**: Telegram user ID → phone number.

- **Config:** In `wrangler.toml` [vars], set `DRIVER_PHONES` to a JSON object (as a string). Keys are Telegram user IDs (strings), values are phone numbers (E.164 recommended, e.g. `+66824245439`).
  - Example: `DRIVER_PHONES = '{"123456789":"+66824245439","987654321":"+66811234567"}'`
- **Getting Telegram user IDs (easiest):** Set `SHOW_DRIVER_ID = "1"` in `wrangler.toml` [vars] and deploy. Whenever a driver accepts a ride, the bot's updated message in the group will include their ID (e.g. `— ✅ Accepted • ETA 15 min (ID: 123456789)`). Have each driver accept a ride, copy the IDs, set `DRIVER_PHONES`, then set `SHOW_DRIVER_ID = "0"` so the ID is no longer shown in the group. Alternatively you can log in the worker or add a simple “who am I?” bot command that replies with the user’s ID. Alternatively, use a one-off script that calls getUpdates and has each driver send a message to the bot.
- **Behaviour:** On accept, the worker looks up `cb.from.id` in the parsed `DRIVER_PHONES` map and stores the normalized number on the ride as `driverPhone`. `GET /api/ride-status/:rideId` returns `driverPhone`; the confirmation page shows a “Driver phone” row with a `tel:` link when present.
- **Empty or invalid:** If `DRIVER_PHONES` is missing, `{}`, or the driver’s ID isn’t in the map, `driverPhone` is not set and the confirmation page hides the driver-phone row.

## Current driver setup

| Driver | Telegram ID | Phone | Status |
|--------|-------------|-------|--------|
| 1 | 5391534676 | +66 82 424 5439 | Configured in `wrangler.toml` |
| 2 | 8322068507 | +66 82 424 5439 | Configured in `wrangler.toml` |
| 3 | — | — | Pending: have driver accept a ride so ID appears in group, then add ID + phone to `DRIVER_PHONES` |

With `SHOW_DRIVER_ID = "1"`, when driver 2 or 3 accepts a ride, the group message will show their ID (e.g. `(ID: 123456789)`). Add each to `DRIVER_PHONES` in the same format as driver 1, then set `SHOW_DRIVER_ID = "0"` and redeploy.

## Edge cases

- **No name:** If Telegram doesn’t send a name or it’s empty, `driverName` is omitted or set to null; confirmation page shows “Your driver” or only “A driver is on the way” and omits the driver row.
- **Existing rides:** Rides accepted before this feature have no `driverName`; confirmation page should not show a driver row or should show a generic line.
- **No phone mapping:** If a driver’s Telegram ID isn’t in `DRIVER_PHONES`, the driver-phone row is hidden on the confirmation page.
