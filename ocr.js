// Frac OCR v6 — Vercel Serverless Function
// Google Gemini Vision with:
//  - current models only, overridable from env (no code change when Google retires one)
//  - retry with backoff on 503/429 instead of giving up on a busy model
//  - structured JSON output (schema) + per-line boxes for tap-to-assign
//  - self-check: items must add up to the printed subtotal; if not, a stronger model re-reads
//  - same-origin check, size cap and per-IP rate limit so nobody else spends the key
//
// Env vars:
//   GEMINI_API_KEY        (required)
//   GEMINI_MODELS_FAST    (optional, comma list)  default: gemini-3.5-flash-lite,gemini-3.1-flash-lite
//   GEMINI_MODELS_STRONG  (optional, comma list)  default: gemini-3.6-flash,gemini-3.8-flash,gemini-flash-latest
//   ALLOWED_ORIGINS       (optional, comma list)  default: https://fracapp.thegriit.com
//
// Diagnostics:  GET /api/ocr?diag=1

var API = 'https://generativelanguage.googleapis.com/v1beta';

function envList(name, fallback) {
  var raw = (process.env[name] || '').trim();
  if (!raw) return fallback.slice();
  return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

var FAST = envList('GEMINI_MODELS_FAST', ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
var STRONG = envList('GEMINI_MODELS_STRONG', ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-latest']);
var ORIGINS = envList('ALLOWED_ORIGINS', ['https://fracapp.thegriit.com']);

// Thinking level per model. Thinking tokens count against maxOutputTokens,
// so extraction runs with the least thinking each model accepts.
var THINKING = {
  'gemini-3.5-flash-lite': 'minimal',
  'gemini-3.1-flash-lite': 'minimal',
  'gemini-3.6-flash': 'low',
  'gemini-3.8-flash': 'low'
};

var MAX_B64 = 4200000;          // ~3.1 MB image; Vercel body limit is 4.5 MB
var DEADLINE_MS = 52000;        // stay under maxDuration 60 (vercel.json)
var CALL_TIMEOUT_MS = 24000;
var RATE_MAX = 10;              // requests per IP per window (per warm instance)
var RATE_WINDOW_MS = 10 * 60 * 1000;
var MATCH_TOL = 0.02;           // dollars

var PROMPT = [
  'You are reading a photo of a restaurant receipt. Extract it exactly as printed.',
  '',
  'items: every ordered line that has a price.',
  '- name: as printed (fix obvious OCR noise, keep the language of the receipt).',
  '- qty: the quantity printed on the line (1 if none).',
  '- lineTotal: the price printed for the whole line. If only a unit price is printed (e.g. "2 @ 6.00"), lineTotal = qty x unit price.',
  '- isAlcohol: true for beer, wine, spirits, cocktails, sangria, mimosas, shots, hard seltzer.',
  '- box_2d: [ymin, xmin, ymax, xmax] of the whole line on the image, normalized 0-1000.',
  '- unsure: true if any digit or the name was hard to read.',
  'Paid add-ons/modifiers with their own price are separate items. Skip lines priced 0.00, voided or comped lines, and never include subtotal, tax, IVU, service charge, gratuity, tip, discount or total as items.',
  '',
  'Totals (0 when not printed): subtotal (before tax), tax (sum of all tax/IVU lines), serviceCharge (service charge / gratuity / automatic tip already added), discount (sum of discounts and coupons, as a positive number), tip (tip already written on the receipt), total (final amount due).',
  'restaurant: business name if printed, else empty. date: YYYY-MM-DD if printed, else empty.',
  'Money values are plain numbers without currency symbols.'
].join('\n');

var NUM = { type: 'NUMBER' };
var SCHEMA = {
  type: 'OBJECT',
  properties: {
    restaurant: { type: 'STRING' },
    date: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          qty: { type: 'INTEGER' },
          lineTotal: NUM,
          isAlcohol: { type: 'BOOLEAN' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          unsure: { type: 'BOOLEAN' }
        },
        required: ['name', 'qty', 'lineTotal', 'isAlcohol']
      }
    },
    subtotal: NUM, tax: NUM, serviceCharge: NUM, discount: NUM, tip: NUM, total: NUM
  },
  required: ['items', 'subtotal', 'total']
};

// ─── helpers ─────────────────────────────────────────────────────────────
function cents(n) { var v = Number(n); return isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
}

function originAllowed(req) {
  var origin = req.headers.origin || '';
  if (!origin) {
    // Some browsers omit Origin on same-origin requests; fall back to Referer.
    var ref = req.headers.referer || '';
    if (!ref) return false;
    origin = ref;
  }
  var oh = hostOf(origin);
  if (!oh) return false;
  if (oh === String(req.headers.host || '').toLowerCase()) return true; // same deployment (prod or preview)
  for (var i = 0; i < ORIGINS.length; i++) { if (hostOf(ORIGINS[i]) === oh) return true; }
  return false;
}

var hits = new Map();
function rateLimited(ip) {
  var now = Date.now();
  var list = (hits.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 2000) { // keep memory bounded on a long-lived instance
    hits.forEach(function (v, k) { if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) hits.delete(k); });
  }
  return list.length > RATE_MAX;
}

function clientIp(req) {
  var xf = String(req.headers['x-forwarded-for'] || '');
  return (xf.split(',')[0] || req.headers['x-real-ip'] || 'unknown').trim();
}

// ─── Gemini call ─────────────────────────────────────────────────────────
function buildBody(img, mime, model, plain) {
  var gen = { maxOutputTokens: 8192, responseMimeType: 'application/json' };
  if (!plain) {
    gen.responseSchema = SCHEMA;
    if (THINKING[model]) gen.thinkingConfig = { thinkingLevel: THINKING[model] };
  }
  return {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: img } }, { text: PROMPT }] }],
    generationConfig: gen
  };
}

async function callOnce(model, key, img, mime, plain, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  try {
    var r = await fetch(API + '/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildBody(img, mime, model, plain)),
      signal: ctrl.signal
    });
    var text = await r.text();
    return { status: r.status, text: text };
  } catch (e) {
    return { status: 0, text: '', error: (e && e.name === 'AbortError') ? 'timeout' : clip(e && e.message, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(envelopeText) {
  var data;
  try { data = JSON.parse(envelopeText); } catch (e) { return { error: 'bad_envelope' }; }
  if (data.promptFeedback && data.promptFeedback.blockReason) return { error: 'blocked' };
  var cand = (data.candidates || [])[0];
  if (!cand) return { error: 'no_candidate' };
  var parts = (cand.content && cand.content.parts) || [];
  var txt = parts.filter(function (p) { return p && typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; }).join('');
  var clean = txt.replace(/\x60\x60\x60json|\x60\x60\x60/g, '').trim();
  var s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s >= 0 && e > s) clean = clean.slice(s, e + 1);
  try {
    var parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) parsed = { items: parsed };
    return { parsed: parsed, finish: cand.finishReason || '' };
  } catch (e2) {
    return { error: cand.finishReason === 'MAX_TOKENS' ? 'truncated' : 'not_json' };
  }
}

function normBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  var v = b.map(function (x) { return Math.max(0, Math.min(1000, Math.round(Number(x)))); });
  if (v.some(function (x) { return !isFinite(x); })) return null;
  if (v[2] <= v[0] || v[3] <= v[1]) return null;
  return v;
}

function normalize(p) {
  var items = (Array.isArray(p.items) ? p.items : []).map(function (it) {
    var qty = parseInt(it && it.qty, 10);
    if (!isFinite(qty) || qty < 1) qty = 1;
    if (qty > 50) qty = 50;
    var line = cents(it && (it.lineTotal != null ? it.lineTotal : (Number(it.price) || 0) * qty));
    var name = clip(String((it && it.name) || '').replace(/\s+/g, ' ').trim(), 60);
    return { name: name, qty: qty, lineTotal: line, isAlcohol: !!(it && it.isAlcohol), box: normBox(it && it.box_2d), unsure: !!(it && it.unsure) };
  }).filter(function (it) { return it.name && it.lineTotal > 0 && it.lineTotal <= 5000; });

  var date = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';

  return {
    restaurant: clip(String(p.restaurant || '').replace(/\s+/g, ' ').trim(), 50),
    date: date,
    items: items,
    subtotal: cents(p.subtotal),
    tax: cents(p.tax),
    serviceCharge: cents(Math.abs(Number(p.serviceCharge) || 0)),
    discount: cents(Math.abs(Number(p.discount) || 0)),
    tip: cents(Math.abs(Number(p.tip) || 0)),
    total: cents(p.total)
  };
}

// Do the items add up to what the receipt printed?
function check(r) {
  var sum = cents(r.items.reduce(function (s, it) { return s + it.lineTotal; }, 0));
  if (!r.items.length) return { status: 'empty', itemsSum: 0, diff: 0 };
  if (r.subtotal > 0) {
    var d1 = cents(sum - r.subtotal);
    var d2 = cents(sum - r.discount - r.subtotal); // some receipts print subtotal after discount
    if (Math.abs(d1) <= MATCH_TOL || (r.discount > 0 && Math.abs(d2) <= MATCH_TOL)) return { status: 'match', itemsSum: sum, diff: 0 };
    return { status: 'mismatch', itemsSum: sum, diff: d1 };
  }
  return { status: 'unverifiable', itemsSum: sum, diff: 0 };
}

// Try one model: retries on busy/timeout, falls back to a plain request on 400.
async function tryModel(model, key, img, mime, t0, log) {
  var plain = false;
  for (var attempt = 0; attempt < 3; attempt++) {
    var left = DEADLINE_MS - (Date.now() - t0);
    if (left < 7000) { log.push({ model: model, reason: 'no_time' }); return null; }
    var out = await callOnce(model, key, img, mime, plain, Math.min(CALL_TIMEOUT_MS, left - 2000));

    if (out.status === 200) {
      var ex = extractJson(out.text);
      if (ex.parsed) {
        var r = normalize(ex.parsed);
        r.check = check(r);
        return r;
      }
      log.push({ model: model, status: 200, reason: ex.error });
      if (ex.error === 'blocked') return null;
      continue; // malformed answer: ask again
    }

    var reason = out.error || clip(out.text, 200);
    try { var ej = JSON.parse(out.text); if (ej && ej.error && ej.error.message) reason = clip(ej.error.message, 200); } catch (e) { /* not JSON */ }
    log.push({ model: model, status: out.status, reason: reason });

    if (out.status === 400 && !plain) { plain = true; attempt--; continue; } // config not accepted: retry plain, free
    if (out.status === 400 || out.status === 401 || out.status === 403 || out.status === 404) return null; // won't fix itself
    // 0 (network/timeout), 429, 500, 503, 504: back off and retry
    await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 400));
  }
  return null;
}

async function firstOf(models, key, img, mime, t0, log) {
  for (var i = 0; i < models.length; i++) {
    var r = await tryModel(models[i], key, img, mime, t0, log);
    if (r) { r.model = models[i]; return r; }
  }
  return null;
}

function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  var rank = { match: 3, unverifiable: 2, mismatch: 1, empty: 0 };
  if (rank[a.check.status] !== rank[b.check.status]) return rank[a.check.status] > rank[b.check.status] ? a : b;
  if (a.check.status === 'mismatch') return Math.abs(a.check.diff) <= Math.abs(b.check.diff) ? a : b;
  return a.items.length >= b.items.length ? a : b;
}

function errorCode(log) {
  if (!log.length) return 'unavailable';
  var busy = log.filter(function (l) { return l.status === 0 || l.status === 429 || l.status >= 500 || l.reason === 'no_time'; }).length;
  var unreadable = log.filter(function (l) { return l.status === 200; }).length;
  if (unreadable && unreadable >= busy) return 'unreadable';
  if (busy) return 'busy';
  return 'unavailable';
}

// ─── handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  var key = process.env.GEMINI_API_KEY;

  if (req.method === 'GET') {
    if (!req.query || !req.query.diag) { res.status(405).json({ error: 'method' }); return; }
    if (!key) { res.status(200).json({ keyPresent: false }); return; }
    try {
      var r = await fetch(API + '/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
      var j = await r.json();
      var usable = (j.models || []).filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
        .map(function (m) { return m.name.replace('models/', ''); });
      res.status(200).json({
        keyPresent: true, listOk: r.ok,
        fast: FAST.map(function (m) { return { model: m, listed: usable.indexOf(m) >= 0 }; }),
        strong: STRONG.map(function (m) { return { model: m, listed: usable.indexOf(m) >= 0 }; })
      });
    } catch (e) {
      res.status(200).json({ keyPresent: true, listOk: false });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  if (!originAllowed(req)) { res.status(403).json({ error: 'forbidden' }); return; }
  if (rateLimited(clientIp(req))) { res.status(429).json({ error: 'rate_limited' }); return; }
  if (!key) { res.status(500).json({ error: 'config' }); return; }

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  var img = typeof body.imgB64 === 'string' ? body.imgB64 : '';
  var mime = body.mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  if (img.length < 100) { res.status(400).json({ error: 'no_image' }); return; }
  if (img.length > MAX_B64) { res.status(413).json({ error: 'too_large' }); return; }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(img.slice(0, 2000))) { res.status(400).json({ error: 'bad_image' }); return; }

  var t0 = Date.now();
  var log = [];
  var best = null, escalated = false;

  try {
    var fast = await firstOf(FAST, key, img, mime, t0, log);
    best = fast;
    var needsSecondLook = !fast || fast.check.status === 'mismatch' || fast.check.status === 'empty';
    if (needsSecondLook && DEADLINE_MS - (Date.now() - t0) > 12000) {
      var strong = await firstOf(STRONG, key, img, mime, t0, log);
      if (strong && fast) escalated = true;
      best = better(fast, strong);
    }
  } catch (e) {
    log.push({ model: '-', reason: clip(e && e.message, 160) });
  }

  if (!best || !best.items.length) {
    console.error('OCR failed', JSON.stringify(log).slice(0, 2000));
    res.status(502).json({ error: best ? 'unreadable' : errorCode(log), attempts: log.slice(-8) });
    return;
  }

  res.status(200).json({
    restaurant: best.restaurant, date: best.date,
    items: best.items,
    subtotal: best.subtotal, tax: best.tax, serviceCharge: best.serviceCharge,
    discount: best.discount, tip: best.tip, total: best.total,
    check: best.check,
    model: best.model, escalated: escalated, ms: Date.now() - t0
  });
}

// Exposed for tests only (ignored by Vercel).
export var _test = { normalize: normalize, check: check, extractJson: extractJson, better: better, originAllowed: originAllowed, errorCode: errorCode, buildBody: buildBody };
