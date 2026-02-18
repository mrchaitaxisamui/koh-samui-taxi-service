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

## Edge cases

- **No name:** If Telegram doesn’t send a name or it’s empty, `driverName` is omitted or set to null; confirmation page shows “Your driver” or only “A driver is on the way” and omits the driver row.
- **Existing rides:** Rides accepted before this feature have no `driverName`; confirmation page should not show a driver row or should show a generic line.
