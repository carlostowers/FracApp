// Frac OCR Proxy — Vercel Serverless Function
// Google Gemini Flash Vision (free tier, no billing required)
// Returns: { items:[...], subtotal, total, serviceCharge }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { imgB64, lang } = req.body || {};
  if (!imgB64) { res.status(400).json({ error: 'No image provided' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'OCR service not configured' }); return; }

  const isES = (lang || 'es') === 'es';

  const prompt = isES
    ? `Analiza este recibo de restaurante. Devuelve UNICAMENTE un objeto JSON, sin markdown ni texto extra:

{"items":[{"name":"Nombre","price":0.00,"isAlcohol":false,"qty":1}],
 "subtotal":0.00,"total":0.00,"serviceCharge":0.00,"discount":0.00}

Reglas para "items":
- SOLO articulos consumidos con precio individual. Nunca subtotales, impuestos, totales, propinas ni cargos por servicio.
- Si aparece "2x Burger 12.00" o "2 @ 6.00", usa qty:2 con price = precio UNITARIO.
- isAlcohol: true para cerveza, vino, ron, vodka, whisky, cocteles, sangria, mimosas, etc.
- Omite lineas sin precio legible.

Reglas para los campos numericos:
- "subtotal": el subtotal impreso ANTES de impuestos. Si no aparece, usa 0.
- "total": el total final impreso. Si no aparece, usa 0.
- "serviceCharge": cargo por servicio / gratuity / propina automatica ya incluida. Si no hay, usa 0.
- "discount": suma de descuentos o cupones como numero POSITIVO. Si no hay, usa 0.`
    : `Analyze this restaurant receipt. Return ONLY a JSON object, no markdown, no extra text:

{"items":[{"name":"Name","price":0.00,"isAlcohol":false,"qty":1}],
 "subtotal":0.00,"total":0.00,"serviceCharge":0.00,"discount":0.00}

Rules for "items":
- ONLY consumed items with an individual price. Never subtotals, taxes, totals, tips or service charges.
- If "2x Burger 12.00" or "2 @ 6.00" appears, use qty:2 with price = UNIT price.
- isAlcohol: true for beer, wine, rum, vodka, whisky, cocktails, sangria, mimosas, etc.
- Skip lines with no readable price.

Rules for numeric fields:
- "subtotal": printed subtotal BEFORE taxes. If absent, use 0.
- "total": final printed total. If absent, use 0.
- "serviceCharge": service charge / gratuity / auto-tip already included. If none, use 0.
- "discount": sum of discounts or coupons as a POSITIVE number. If none, use 0.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: imgB64 } },
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini API error:', err);
      res.status(502).json({ error: 'OCR service error', detail: err });
      return;
    }

    const data    = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean   = content.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error('Parse error, raw:', clean.slice(0, 400));
      res.status(200).json({ items: [], subtotal: 0, total: 0, serviceCharge: 0, discount: 0, raw: clean });
      return;
    }

    // Legacy safety: if model returned a bare array, wrap it
    if (Array.isArray(parsed)) parsed = { items: parsed };

    res.status(200).json({
      items:         Array.isArray(parsed.items) ? parsed.items : [],
      subtotal:      Number(parsed.subtotal)      || 0,
      total:         Number(parsed.total)         || 0,
      serviceCharge: Number(parsed.serviceCharge) || 0,
      discount:      Number(parsed.discount)      || 0
    });

  } catch (err) {
    console.error('OCR proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
