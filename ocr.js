// Frac OCR — Vercel Serverless Function
// Google Gemini Vision. Tries several models in order so a model
// deprecation never takes the app down again.
//
// Diagnostics:  GET /api/ocr?diag=1   -> lists models your key can use

const MODELS = [
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite'
];

const API = 'https://generativelanguage.googleapis.com/v1beta';

function buildPrompt(isES) {
  return isES
? `Analiza este recibo de restaurante. Devuelve UNICAMENTE un objeto JSON, sin markdown ni texto extra:

{"items":[{"name":"Nombre","price":0.00,"isAlcohol":false,"qty":1}],
 "subtotal":0.00,"total":0.00,"serviceCharge":0.00,"discount":0.00}

Reglas para "items":
- SOLO articulos consumidos con precio individual. Nunca subtotales, impuestos, totales, propinas ni cargos por servicio.
- Si aparece "2x Burger 12.00" o "2 @ 6.00", usa qty:2 con price = precio UNITARIO.
- isAlcohol: true para cerveza, vino, ron, vodka, whisky, cocteles, sangria, mimosas, etc.
- Omite lineas sin precio legible.

Campos numericos (usa 0 si no aparecen):
- "subtotal": subtotal impreso ANTES de impuestos.
- "total": total final impreso.
- "serviceCharge": cargo por servicio / gratuity / propina automatica ya incluida.
- "discount": suma de descuentos o cupones, como numero POSITIVO.`
: `Analyze this restaurant receipt. Return ONLY a JSON object, no markdown, no extra text:

{"items":[{"name":"Name","price":0.00,"isAlcohol":false,"qty":1}],
 "subtotal":0.00,"total":0.00,"serviceCharge":0.00,"discount":0.00}

Rules for "items":
- ONLY consumed items with an individual price. Never subtotals, taxes, totals, tips or service charges.
- If "2x Burger 12.00" or "2 @ 6.00" appears, use qty:2 with price = UNIT price.
- isAlcohol: true for beer, wine, rum, vodka, whisky, cocktails, sangria, mimosas, etc.
- Skip lines with no readable price.

Numeric fields (use 0 if absent):
- "subtotal": printed subtotal BEFORE taxes.
- "total": final printed total.
- "serviceCharge": service charge / gratuity / auto-tip already included.
- "discount": sum of discounts or coupons, as a POSITIVE number.`;
}

async function callModel(model, apiKey, imgB64, prompt) {
  const r = await fetch(`${API}/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: imgB64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    })
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiKey = process.env.GEMINI_API_KEY;

  // ── Diagnostics: which models does this key actually have? ──
  if (req.method === 'GET') {
    if (!apiKey) { res.status(200).json({ keyPresent: false, hint: 'Add GEMINI_API_KEY in Vercel > Settings > Environment Variables, then redeploy.' }); return; }
    try {
      const r = await fetch(`${API}/models?key=${apiKey}&pageSize=200`);
      const txt = await r.text();
      if (!r.ok) { res.status(200).json({ keyPresent: true, listOk: false, status: r.status, error: txt.slice(0, 600) }); return; }
      const j = JSON.parse(txt);
      const usable = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
      res.status(200).json({
        keyPresent: true,
        listOk: true,
        totalUsable: usable.length,
        preferred: MODELS.filter(m => usable.includes(m)),
        flashModels: usable.filter(m => m.includes('flash')).slice(0, 25)
      });
    } catch (e) {
      res.status(200).json({ keyPresent: true, listOk: false, error: String(e).slice(0, 300) });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { imgB64, lang } = req.body || {};
  if (!imgB64) { res.status(400).json({ error: 'No image provided' }); return; }
  if (!apiKey) { res.status(500).json({ error: 'OCR service not configured' }); return; }

  const prompt = buildPrompt((lang || 'es') === 'es');
  const attempts = [];

  for (const model of MODELS) {
    let out;
    try {
      out = await callModel(model, apiKey, imgB64, prompt);
    } catch (e) {
      attempts.push({ model, error: String(e).slice(0, 200) });
      continue;
    }

    if (!out.ok) {
      attempts.push({ model, status: out.status, error: out.body.slice(0, 300) });
      continue; // try next model
    }

    let content = '';
    try {
      const data = JSON.parse(out.body);
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch {
      attempts.push({ model, error: 'unparseable API envelope' });
      continue;
    }

    // Pull the JSON object out of whatever the model wrapped it in
    let clean = content.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s >= 0 && e > s) clean = clean.slice(s, e + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      attempts.push({ model, error: 'model did not return JSON', sample: content.slice(0, 200) });
      continue;
    }

    if (Array.isArray(parsed)) parsed = { items: parsed };

    res.status(200).json({
      items:         Array.isArray(parsed.items) ? parsed.items : [],
      subtotal:      Number(parsed.subtotal)      || 0,
      total:         Number(parsed.total)         || 0,
      serviceCharge: Number(parsed.serviceCharge) || 0,
      discount:      Number(parsed.discount)      || 0,
      modelUsed:     model
    });
    return;
  }

  // Every model failed — send the real reasons back so we can see them
  console.error('All models failed:', JSON.stringify(attempts));
  res.status(502).json({ error: 'OCR service error', attempts });
}
