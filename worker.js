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
        endpoints: ['POST /api/ride-request', 'GET /api/ride-status/:rideId', 'POST /api/telegram-webhook'],
      });
    }

    // POST /api/ride-request
    if (request.method === 'POST' && url.pathname === '/api/ride-request') {
      return handleRideRequest(request, env);
    }
    // GET /api/ride-status/:rideId
    if (request.method === 'GET' && url.pathname.startsWith('/api/ride-status/')) {
      const rideId = url.pathname.replace(/^\/api\/ride-status\//, '').split('/')[0];
      if (!rideId) return jsonResponse({ error: 'Missing rideId' }, 400);
      return handleRideStatus(rideId, env);
    }
    // POST /api/telegram-webhook (Telegram sends updates here)
    if (request.method === 'POST' && url.pathname === '/api/telegram-webhook') {
      return handleTelegramWebhook(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

async function handleRideRequest(request, env) {
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

  const ride = {
    rideId,
    status: 'pending',
    pickup: { lat: pickupLat, lng: pickupLng, address: pickupAddress },
    destination: { lat: destLat, lng: destLng, address: destAddress },
    timestamp: Date.now(),
    customerName: String(customerName || '').trim() || null,
    customerPhone: phoneE164,
    distanceKm,
  };

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_DRIVER_CHAT_ID;
  const telegramPromise =
    token && chatId
      ? (async () => {
          const nameLine = ride.customerName ? `👤 Name: ${ride.customerName}` : '';
          const text = [
            '🚕 NEW RIDE REQUEST',
            `🆔 Booking ID: ${rideId}`,
            `📍 Pickup: ${pickupAddress}`,
            `🏁 Destination: ${destAddress}`,
            nameLine,
            `📱 Customer: ${parsed.format('INTERNATIONAL')}`,
            `⏰ Distance: ${distanceKm} km`,
          ].filter(Boolean).join('\n');
          const keyboard = {
            inline_keyboard: [
              [
                { text: '✅ Accept', callback_data: `accept:${rideId}` },
                { text: '❌ Decline', callback_data: `decline:${rideId}` },
              ],
            ],
          };
          try {
            const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text,
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

  // Run KV put and Telegram send in parallel so drivers get the message as fast as possible
  await Promise.all([
    env.RIDES.put(rideId, JSON.stringify(ride), { expirationTtl: 60 * 60 * 24 }), // 24h TTL
    telegramPromise,
  ]);

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
  });
}

async function handleTelegramWebhook(request, env) {
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('OK', { status: 200 });
  }
  const cb = update?.callback_query;
  if (!cb?.data) return new Response('OK', { status: 200 });
  const [action, rideId] = cb.data.split(':');
  if (!rideId || (action !== 'accept' && action !== 'decline')) {
    await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, 'Unknown action');
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
  const token = env.TELEGRAM_BOT_TOKEN;
  const answerText = action === 'accept' ? 'Accepted!' : 'Declined';
  // Update KV and give driver immediate feedback in parallel
  await Promise.all([
    env.RIDES.put(rideId, JSON.stringify(ride), { expirationTtl: 60 * 60 * 24 }),
    answerCallback(token, cb.id, answerText),
  ]);
  // Edit the message to remove buttons and show result so driver sees clear feedback
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const suffix = action === 'accept' ? '\n\n— ✅ Accepted' : '\n\n— ❌ Declined';
  const newText = (cb.message?.text || '') + suffix;
  if (token && chatId != null && messageId != null) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          reply_markup: { inline_keyboard: [] },
        }),
      });
    } catch (e) {
      console.error('editMessageText failed', e);
    }
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
