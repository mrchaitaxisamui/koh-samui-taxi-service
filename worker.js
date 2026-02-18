/**
 * Mr Chai Lightweight Dispatch - Cloudflare Worker
 * Phase 2: Ride request, KV state, Telegram notifications + webhook.
 *
 * Endpoints:
 *   POST /api/ride-request   - Create ride, store in KV, notify Telegram
 *   GET  /api/ride-status/:rideId - Poll status (pending | accepted | declined)
 *   POST /api/telegram-webhook   - Handle Accept/Decline callback from Telegram
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(status = 204) {
  return new Response(null, { status, headers: CORS_HEADERS });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Approximate distance in km (Haversine). */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/** Normalize phone for display (e.g. +66 82 424 5439). */
function formatPhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0) return raw;
  const withPlus = digits.startsWith('66') ? digits : '66' + digits;
  return '+66 ' + withPlus.replace(/^66/, '').replace(/(\d{2})(?=\d)/g, '$1 ');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return corsResponse();

    // Health check for deployment verification (GET / or GET /api/health)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/health')) {
      return jsonResponse({
        ok: true,
        service: 'mrchai-dispatch',
        endpoints: ['POST /api/ride-request', 'GET /api/ride-status/:rideId', 'POST /api/telegram-webhook', 'GET /api/places-autocomplete', 'GET /api/place-details', 'GET /api/geocode', 'GET /api/static-map', 'GET /api/distance-matrix'],
      });
    }

    // POST /api/ride-request
    if (request.method === 'POST' && url.pathname === '/api/ride-request') {
      return handleRideRequest(request, env, ctx);
    }
    // GET /api/ride-status/:rideId
    if (request.method === 'GET' && url.pathname.startsWith('/api/ride-status/')) {
      const rideId = url.pathname.replace(/^\/api\/ride-status\//, '').split('/')[0];
      if (!rideId) return jsonResponse({ error: 'Missing rideId' }, 400);
      return handleRideStatus(rideId, env);
    }
    // POST /api/telegram-webhook (Telegram sends updates here)
    if (request.method === 'POST' && url.pathname === '/api/telegram-webhook') {
      return handleTelegramWebhook(request, env, ctx);
    }
    // GET /api/geocode?lat=...&lng=... — reverse geocode via Google (key server-side)
    if (request.method === 'GET' && url.pathname === '/api/geocode') {
      return handleGeocode(url, env);
    }
    // GET /api/places-autocomplete?input=... — Google Places Autocomplete (key server-side)
    if (request.method === 'GET' && url.pathname === '/api/places-autocomplete') {
      return handlePlacesAutocomplete(url, env);
    }
    // GET /api/place-details?place_id=... — Google Place Details for lat/lng/address (key server-side)
    if (request.method === 'GET' && url.pathname === '/api/place-details') {
      return handlePlaceDetails(url, env);
    }
    // GET /api/static-map?pickup_lat=...&pickup_lng=...&dest_lat=...&dest_lng=... — static map image (key server-side)
    if (request.method === 'GET' && url.pathname === '/api/static-map') {
      return handleStaticMap(url, env);
    }
    // GET /api/distance-matrix?origins=lat,lng&destinations=lat,lng — driving distance in km (key server-side)
    if (request.method === 'GET' && url.pathname === '/api/distance-matrix') {
      return handleDistanceMatrix(url, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

async function handleGeocode(url, env) {
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const latNum = lat != null ? Number(lat) : NaN;
  const lngNum = lng != null ? Number(lng) : NaN;
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum) ||
      latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    return jsonResponse({ error: 'Invalid or missing lat/lng' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Geocoding not configured' }, 503);
  }
  try {
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latNum},${lngNum}&key=${encodeURIComponent(key)}`;
    const res = await fetch(geoUrl);
    const data = await res.json().catch(() => ({}));
    const status = data.status || 'UNKNOWN';
    if (status === 'OK') {
      if (!Array.isArray(data.results) || data.results.length === 0) {
        return jsonResponse({ error: 'No address found for this location.' }, 502);
      }
      const formatted = data.results[0].formatted_address;
      if (!formatted || typeof formatted !== 'string') {
        return jsonResponse({ error: 'No address found for this location.' }, 502);
      }
      return jsonResponse({ formatted_address: formatted });
    }
    if (status === 'ZERO_RESULTS') {
      return jsonResponse({ error: 'No address found for this location.' }, 502);
    }
    if (status === 'REQUEST_DENIED') {
      const reason = (data.error_message || '').toLowerCase();
      const hint = reason.includes('referrer') || reason.includes('restrict')
        ? ' Use an API key that is not restricted to HTTP referrers (this request is server-side).'
        : ' Enable Geocoding API and check key restrictions in Google Cloud Console.';
      return jsonResponse({ error: 'Google Geocoding denied the request.' + hint }, 502);
    }
    if (status === 'OVER_QUERY_LIMIT') {
      return jsonResponse({ error: 'Geocoding limit reached. Try again later or enter manually.' }, 502);
    }
    if (status === 'INVALID_REQUEST' || status === 'UNKNOWN_ERROR') {
      return jsonResponse({ error: 'Geocoding request failed. Please enter manually.' }, 502);
    }
    return jsonResponse({ error: 'Geocoding failed (' + status + '). Please enter manually.' }, 502);
  } catch (e) {
    console.error('Geocode fetch failed', e);
    return jsonResponse({ error: 'Geocoding service unavailable. Please enter manually.' }, 502);
  }
}

/** Koh Samui bounds: south,west|north,east for locationrestriction */
const KOH_SAMUI_RECT = '9.38,99.85|9.62,100.12';

async function handlePlacesAutocomplete(url, env) {
  const input = url.searchParams.get('input');
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Places autocomplete not configured' }, 503);
  }
  if (!input || typeof input !== 'string' || input.trim().length < 2) {
    return jsonResponse({ predictions: [] });
  }
  const params = new URLSearchParams({
    input: input.trim(),
    key,
    components: 'country:th',
    locationrestriction: `rectangle:${KOH_SAMUI_RECT}`,
    language: 'en',
  });
  /* Omit types so we get both addresses (geocode) and establishments (bars, hotels, etc. e.g. Ark Bar) */
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    const status = data.status || 'UNKNOWN';
    if (status === 'OK') {
      const predictions = Array.isArray(data.predictions) ? data.predictions : [];
      return jsonResponse({ predictions });
    }
    if (status === 'ZERO_RESULTS') {
      return jsonResponse({ predictions: [] });
    }
    if (status === 'REQUEST_DENIED') {
      return jsonResponse({ error: 'Places autocomplete denied.', predictions: [] }, 502);
    }
    if (status === 'OVER_QUERY_LIMIT') {
      return jsonResponse({ error: 'Places limit reached. Try again later.', predictions: [] }, 502);
    }
    return jsonResponse({ predictions: [] });
  } catch (e) {
    console.error('Places autocomplete fetch failed', e);
    return jsonResponse({ error: 'Places service unavailable.', predictions: [] }, 502);
  }
}

async function handlePlaceDetails(url, env) {
  const placeId = url.searchParams.get('place_id');
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Place details not configured' }, 503);
  }
  if (!placeId || typeof placeId !== 'string' || !placeId.trim()) {
    return jsonResponse({ error: 'Missing place_id' }, 400);
  }
  const params = new URLSearchParams({
    place_id: placeId.trim(),
    key,
    fields: 'formatted_address,geometry,name',
  });
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    const status = data.status || 'UNKNOWN';
    if (status === 'OK' && data.result) {
      const r = data.result;
      const loc = r.geometry && r.geometry.location;
      const lat = loc && typeof loc.lat === 'number' ? loc.lat : null;
      const lng = loc && typeof loc.lng === 'number' ? loc.lng : null;
      const address = (typeof r.formatted_address === 'string' && r.formatted_address) || r.name || null;
      if (lat != null && lng != null && address) {
        return jsonResponse({ lat, lng, address: address.trim() });
      }
    }
    if (status === 'NOT_FOUND' || status === 'ZERO_RESULTS') {
      return jsonResponse({ error: 'Place not found' }, 404);
    }
    if (status === 'REQUEST_DENIED') {
      return jsonResponse({ error: 'Place details denied.' }, 502);
    }
    return jsonResponse({ error: 'Could not get place details.' }, 502);
  } catch (e) {
    console.error('Place details fetch failed', e);
    return jsonResponse({ error: 'Place details unavailable.' }, 502);
  }
}

/** GET /api/distance-matrix?origins=lat,lng&destinations=lat,lng — driving distance in km via Google Distance Matrix (key server-side). */
async function handleDistanceMatrix(url, env) {
  const origins = url.searchParams.get('origins');
  const destinations = url.searchParams.get('destinations');
  if (!origins || !destinations || typeof origins !== 'string' || typeof destinations !== 'string') {
    return jsonResponse({ error: 'Missing origins or destinations (use lat,lng)' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Distance Matrix not configured' }, 503);
  }
  const params = new URLSearchParams({
    origins: origins.trim(),
    destinations: destinations.trim(),
    key,
    mode: 'driving',
  });
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    const status = data.status || 'UNKNOWN';
    if (status === 'OK') {
      const rows = data.rows;
      if (Array.isArray(rows) && rows.length > 0) {
        const elements = rows[0].elements;
        if (Array.isArray(elements) && elements.length > 0) {
          const el = elements[0];
          if (el.status === 'OK' && el.distance && typeof el.distance.value === 'number') {
            const distanceKm = Math.round((el.distance.value / 1000) * 10) / 10;
            return jsonResponse({ distance_km: distanceKm });
          }
        }
      }
      return jsonResponse({ error: 'No route found' }, 502);
    }
    if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') {
      return jsonResponse({ error: 'No route found' }, 502);
    }
    if (status === 'REQUEST_DENIED') {
      return jsonResponse({ error: 'Distance Matrix denied. Enable Distance Matrix API and check key.' }, 502);
    }
    if (status === 'OVER_QUERY_LIMIT') {
      return jsonResponse({ error: 'Distance Matrix limit reached. Try again later.' }, 502);
    }
    return jsonResponse({ error: 'Distance Matrix failed (' + status + ')' }, 502);
  } catch (e) {
    console.error('Distance Matrix fetch failed', e);
    return jsonResponse({ error: 'Distance Matrix unavailable' }, 502);
  }
}

/** GET /api/static-map?pickup_lat=...&pickup_lng=...&dest_lat=...&dest_lng=... — proxy Google Static Map (key server-side). */
async function handleStaticMap(url, env) {
  const pickupLat = Number(url.searchParams.get('pickup_lat'));
  const pickupLng = Number(url.searchParams.get('pickup_lng'));
  const destLat = Number(url.searchParams.get('dest_lat'));
  const destLng = Number(url.searchParams.get('dest_lng'));
  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) || !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return jsonResponse({ error: 'Missing or invalid pickup_lat, pickup_lng, dest_lat, dest_lng' }, 400);
  }
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return jsonResponse({ error: 'Static map not configured' }, 503);
  }
  const params = new URLSearchParams({
    size: '600x180',
    scale: '2',
    key,
    markers: `color:green|label:P|${pickupLat},${pickupLng}`,
  });
  params.append('markers', `color:red|label:D|${destLat},${destLng}`);
  try {
    const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
    const res = await fetch(mapUrl);
    if (!res.ok) {
      return jsonResponse({ error: 'Static map failed' }, 502);
    }
    const contentType = res.headers.get('Content-Type') || 'image/png';
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentType, ...CORS_HEADERS, 'Cache-Control': 'private, max-age=300' },
    });
  } catch (e) {
    console.error('Static map fetch failed', e);
    return jsonResponse({ error: 'Static map unavailable' }, 502);
  }
}

async function handleRideRequest(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  const {
    pickup = {},
    destination = {},
    customerName,
    customerPhone,
    estimatedPrice,
  } = body;
  const pickupLat = Number(pickup.lat);
  const pickupLng = Number(pickup.lng);
  const destLat = Number(destination.lat);
  const destLng = Number(destination.lng);
  const phoneRaw = String(customerPhone || '').trim();
  const digits = phoneRaw.replace(/\D/g, '');
  // Treat as international: prepend + if missing (e.g. "49 17..." -> +49 Germany)
  const toParse = phoneRaw.startsWith('+') ? phoneRaw : '+' + digits;
  const parsed = parsePhoneNumberFromString(toParse);
  if (!parsed || !parsed.isValid()) {
    return jsonResponse({
      error: 'Invalid or unsupported phone number. Use international format with country code (e.g. +66 82 123 4567, +44 7700 900000).',
    }, 400);
  }
  const phoneE164 = parsed.format('E.164');
  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) ||
      !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return jsonResponse({
      error: 'Missing or invalid pickup or destination coordinates',
    }, 400);
  }

  // Optional: rate limit by IP (1 request per 30s per IP)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const rateKey = 'rate:' + ip;
  const last = await env.RIDES.get(rateKey);
  if (last && Date.now() - parseInt(last, 10) < 30000) {
    return jsonResponse({ error: 'Please wait a moment before requesting again' }, 429);
  }
  await env.RIDES.put(rateKey, String(Date.now()), { expirationTtl: 60 });

  const rideId = crypto.randomUUID();
  const distanceKm = haversineKm(pickupLat, pickupLng, destLat, destLng);
  const pickupAddress = pickup.address || `${pickupLat.toFixed(5)}, ${pickupLng.toFixed(5)}`;
  const destAddress = destination.address || `${destLat.toFixed(5)}, ${destLng.toFixed(5)}`;

  const priceThb = typeof estimatedPrice === 'number' && Number.isFinite(estimatedPrice) && estimatedPrice >= 0
    ? estimatedPrice
    : null;
  const ride = {
    rideId,
    status: 'pending',
    pickup: { lat: pickupLat, lng: pickupLng, address: pickupAddress },
    destination: { lat: destLat, lng: destLng, address: destAddress },
    timestamp: Date.now(),
    customerName: String(customerName || '').trim() || null,
    customerPhone: phoneE164,
    distanceKm,
    estimatedPriceThb: priceThb,
  };

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_DRIVER_CHAT_ID;
  const telegramPromise =
    token && chatId
      ? (async () => {
          const pickupMapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(pickupLat)},${encodeURIComponent(pickupLng)}`;
          const destMapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(destLat)},${encodeURIComponent(destLng)}`;
          // Plain text + entities so links are reliably clickable (no parse_mode)
          const line1 = '🚕 NEW RIDE REQUEST';
          const line2 = `🆔 Booking ID: ${rideId}`;
          const line3Prefix = '📍 Pickup: ';
          const line4Prefix = '🏁 Destination: ';
          const line5 = `👤 Name: ${ride.customerName || '—'}`;
          const line6 = `📱 Customer: ${parsed.format('INTERNATIONAL')}`;
          const line7 = `⏰ Distance: ${distanceKm} km`;
          const line8 = `💰 Price: ${priceThb != null ? priceThb + ' THB' : '—'}`;
          const text = [line1, line2, line3Prefix + pickupAddress, line4Prefix + destAddress, line5, line6, line7, line8].join('\n');
          const pickupStart = (line1 + '\n' + line2 + '\n' + line3Prefix).length;
          const destStart = (line1 + '\n' + line2 + '\n' + line3Prefix + pickupAddress + '\n' + line4Prefix).length;
          const entities = [
            { type: 'text_link', offset: pickupStart, length: pickupAddress.length, url: pickupMapsUrl },
            { type: 'text_link', offset: destStart, length: destAddress.length, url: destMapsUrl },
          ];
          const keyboard = {
            inline_keyboard: [
              [
                { text: '✅ 15 min', callback_data: `accept:${rideId}:15` },
                { text: '✅ 30 min', callback_data: `accept:${rideId}:30` },
              ],
              [
                { text: '✅ 45 min', callback_data: `accept:${rideId}:45` },
                { text: '✅ 60 min', callback_data: `accept:${rideId}:60` },
              ],
              [{ text: '❌ Decline', callback_data: `decline:${rideId}` }],
            ],
          };
          try {
            const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text,
                entities,
                reply_markup: keyboard,
              }),
            });
            const tgJson = await tgRes.json().catch(() => ({}));
            if (!tgJson.ok) {
              console.error('Telegram sendMessage failed:', tgJson.description || tgRes.status, tgJson);
            }
          } catch (e) {
            console.error('Telegram send failed', e);
          }
        })()
      : Promise.resolve();
  if (!token) console.error('TELEGRAM_BOT_TOKEN not set. Run: npx wrangler secret put TELEGRAM_BOT_TOKEN');
  if (!chatId) console.error('TELEGRAM_DRIVER_CHAT_ID not set in wrangler.toml [vars]');

  // Store ride in KV first so user can start polling immediately
  await env.RIDES.put(rideId, JSON.stringify(ride), { expirationTtl: 60 * 60 * 24 }); // 24h TTL
  // Fire Telegram send in background - user gets response without waiting for Telegram API
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(telegramPromise);
  } else {
    await telegramPromise;
  }
  return jsonResponse({ rideId, status: 'pending' });
}

async function handleRideStatus(rideId, env) {
  const raw = await env.RIDES.get(rideId);
  if (!raw) return jsonResponse({ error: 'Ride not found' }, 404);
  const ride = JSON.parse(raw);
  return jsonResponse({
    rideId: ride.rideId,
    status: ride.status,
    pickup: ride.pickup,
    destination: ride.destination,
    timestamp: ride.timestamp,
    distanceKm: ride.distanceKm,
    etaMinutes: ride.etaMinutes ?? null,
    driverName: ride.driverName ?? null,
  });
}

async function handleTelegramWebhook(request, env, ctx) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('OK', { status: 200 });
  }
  const cb = update?.callback_query;
  if (!cb?.data) return new Response('OK', { status: 200 });
  const parts = cb.data.split(':');
  const action = parts[0];
  const rideId = parts[1];
  const etaMinutes = parts[2] ? parseInt(parts[2], 10) : null;
  const validEta = [15, 30, 45, 60].includes(etaMinutes);
  if (!rideId || (action !== 'accept' && action !== 'decline')) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, 'Unknown action');
    return new Response('OK', { status: 200 });
  }
  if (action === 'accept' && parts.length === 3 && !validEta) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, 'Unknown ETA');
    return new Response('OK', { status: 200 });
  }
  const raw = await env.RIDES.get(rideId);
  if (!raw) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, 'Ride no longer available');
    return new Response('OK', { status: 200 });
  }
  const ride = JSON.parse(raw);
  if (ride.status !== 'pending') {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, `Already ${ride.status}`);
    return new Response('OK', { status: 200 });
  }
  ride.status = action === 'accept' ? 'accepted' : 'declined';
  if (action === 'accept' && validEta) ride.etaMinutes = etaMinutes;
  if (action === 'accept' && cb.from) {
    const first = (cb.from.first_name || '').trim();
    const last = (cb.from.last_name || '').trim();
    ride.driverName = [first, last].filter(Boolean).join(' ') || null;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const answerText = action === 'accept' ? `Accepted! ETA ${ride.etaMinutes || 15} min` : 'Declined';
  // Update KV and give driver immediate feedback in parallel - must complete before returning
  await Promise.all([
    env.RIDES.put(rideId, JSON.stringify(ride), { expirationTtl: 60 * 60 * 24 }),
    answerCallback(token, cb.id, answerText),
  ]);
  // Edit message in background - return 200 to Telegram fast so we don't hold the webhook
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const etaLabel = ride.etaMinutes ? ` • ETA ${ride.etaMinutes} min` : '';
  const suffix = action === 'accept' ? `\n\n— ✅ Accepted${etaLabel}` : '\n\n— ❌ Declined';
  const origText = cb.message?.text || '';
  const newText = origText + suffix;
  const editPromise =
    token && chatId != null && messageId != null
      ? (async () => {
          try {
            const editPayload = {
              chat_id: chatId,
              message_id: messageId,
              text: newText,
              reply_markup: { inline_keyboard: [] },
            };
            const entities = cb.message?.entities;
            if (entities && Array.isArray(entities) && entities.length > 0) {
              editPayload.entities = entities;
            }
            await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(editPayload),
            });
          } catch (e) {
            console.error('editMessageText failed', e);
          }
        })()
      : Promise.resolve();
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(editPromise);
  } else {
    await editPromise;
  }
  return new Response('OK', { status: 200 });
}

async function answerCallback(token, callbackQueryId, text) {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    console.error('answerCallbackQuery failed', e);
  }
}
