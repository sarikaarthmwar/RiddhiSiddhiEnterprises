const crypto = require('crypto');

const RETENTION_SECONDS = 60 * 60 * 24 * 365;

function storageUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}

function storageToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
}

function kvEnabled() {
  return Boolean(storageUrl() && storageToken());
}

async function kvPipeline(commands) {
  const response = await fetch(storageUrl() + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + storageToken(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('PropertyIQ storage request failed.');
  return response.json();
}

function cleanText(value, max = 300) {
  return typeof value === 'string'
    ? value.trim().replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, max)
    : '';
}

function makeAnalysisId(input) {
  const canonical = JSON.stringify({
    project: cleanText(input.project, 160).toLowerCase(),
    location: cleanText(input.location, 160).toLowerCase(),
    propertyType: cleanText(input.propertyType, 80).toLowerCase(),
    area: String(input.area || ''),
    price: Number(input.price) || 0,
    listingUrl: cleanText(input.listingUrl, 500)
  });
  return 'piq-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deterministicValuation(result, input) {
  const comparables = Array.isArray(result.comparables) ? result.comparables : [];
  const weights = {
    same_project: 0.45,
    same_micro_market: 0.30,
    similar_project: 0.20,
    other: 0.05
  };

  const evidence = comparables
    .map((item) => ({
      name: cleanText(item.name, 160),
      location: cleanText(item.location, 160),
      pricePerSqft: numeric(item.pricePerSqft),
      relevance: weights[item.relevance] ? item.relevance : 'other',
      sourceTitle: cleanText(item.sourceTitle, 180),
      sourceUrl: cleanText(item.sourceUrl, 500),
      evidenceDate: cleanText(item.evidenceDate, 40)
    }))
    .filter((item) => item.pricePerSqft && item.sourceUrl);

  if (!evidence.length) return null;

  const totalWeight = evidence.reduce((sum, item) => sum + weights[item.relevance], 0);
  const weightedRate = evidence.reduce(
    (sum, item) => sum + item.pricePerSqft * weights[item.relevance],
    0
  ) / totalWeight;

  const weightedVariance = evidence.reduce(
    (sum, item) => sum + weights[item.relevance] * Math.pow(item.pricePerSqft - weightedRate, 2),
    0
  ) / totalWeight;
  const weightedStdDev = Math.sqrt(weightedVariance);

  const lowEvidence = Math.min(...evidence.map((item) => item.pricePerSqft));
  const highEvidence = Math.max(...evidence.map((item) => item.pricePerSqft));
  const band = Math.max(weightedStdDev, weightedRate * 0.05);
  const low = Math.max(lowEvidence, weightedRate - band);
  const high = Math.min(highEvidence, weightedRate + band);

  const area = numeric(input.area);
  const quotedPrice = numeric(input.price);
  const quotedRate = area ? quotedPrice / area : null;
  const premiumPct = quotedRate ? ((quotedRate - weightedRate) / weightedRate) * 100 : null;

  return {
    method: 'Weighted comparable evidence',
    formula: 'Same project 45% + same micro-market 30% + similar project 20% + other 5%; normalized across available evidence.',
    marketRatePerSqft: Math.round(weightedRate),
    lowRatePerSqft: Math.round(low),
    highRatePerSqft: Math.round(high),
    quotedRatePerSqft: quotedRate ? Math.round(quotedRate) : null,
    quotedPremiumPct: premiumPct == null ? null : Math.round(premiumPct * 10) / 10,
    estimatedValueLow: area ? Math.round(low * area) : null,
    estimatedValueHigh: area ? Math.round(high * area) : null,
    comparablesUsed: evidence.length,
    confidence: evidence.length >= 5 ? 'High' : evidence.length >= 3 ? 'Medium' : 'Low',
    evidence
  };
}

async function storeAnalysis(analysisId, input, result, valuation) {
  if (!kvEnabled()) return;
  const record = {
    analysisId,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    input: {
      project: cleanText(input.project, 160),
      location: cleanText(input.location, 160),
      propertyType: cleanText(input.propertyType, 80),
      investmentIntent: cleanText(input.investmentIntent, 80),
      area: input.area || null,
      price: Number(input.price) || null,
      listingUrl: cleanText(input.listingUrl, 500)
    },
    analysis: result,
    evidence: valuation?.evidence || result.comparables || [],
    valuation
  };
  await kvPipeline([[
    'SET',
    'propertyiq:analysis:' + analysisId,
    JSON.stringify(record),
    'EX',
    RETENTION_SECONDS
  ]]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'PropertyIQ is not configured. Add GEMINI_API_KEY in Vercel Environment Variables.' });

  try {
    const body = req.body || {};
    const { project, location, propertyType, area, price, listingUrl } = body;
    if (!project || !location || !price) return res.status(400).json({ error: 'Project, location and quoted price are required.' });

    const analysisId = cleanText(body.analysisId, 100) || makeAnalysisId(body);

    const prompt = `You are PropertyIQ, an evidence-led real-estate investment analyst focused on India.
Research the property using current web information and Google Search grounding. Never invent facts or URLs. If evidence is unavailable, use null or an explicit data gap.
Write for a busy homebuyer: lead with one clear recommendation, use short plain-English sentences, and limit every array to 3 specific points. State uncertainty plainly instead of using jargon.
PROPERTY: Project=${project}; Location=${location}; Type=${propertyType || 'Not specified'}; Area=${area || 'Not specified'} sq.ft.; Quoted price=INR ${price}; Listing URL=${listingUrl || 'Not provided'}.
RESEARCH: identify project/developer/location using official developer, RERA or government sources where available; find current market-price evidence and comparable properties; estimate rental economics; estimate conservative 5-year annual appreciation range from evidence; assess rental demand, resale liquidity, supply, connectivity and demand drivers; identify material risks; score valuation, rental economics, growth, liquidity and risk into PropertyIQ 0-100 and verdict BUY, NEGOTIATE, WATCH or AVOID; calculate break-even appreciation versus a 10% alternative return only when enough inputs exist; give downside/base/upside appreciation ranges.
IMPORTANT VALUATION RULE: do not invent a market rate. Return individual comparable evidence in the comparables array. Each comparable must have a numeric pricePerSqft, a relevance value of same_project, same_micro_market, similar_project or other, and a real source URL actually supporting that comparable. Prefer at least 5 comparables when evidence exists. If evidence is insufficient, return an empty comparables array and explain the gap in dataGaps.
The server will calculate the final market rate deterministically from the comparables, so marketPricePerSqft must be treated as supporting context only.
Return only the structured JSON object requested by the response schema.`;

    const schema = {
      type: 'OBJECT',
      properties: {
        propertyName: { type: 'STRING' },
        developer: { type: 'STRING' },
        locationSummary: { type: 'STRING' },
        marketPricePerSqft: {
          type: 'OBJECT',
          properties: {
            low: { type: 'NUMBER' }, high: { type: 'NUMBER' }, unit: { type: 'STRING' }, confidence: { type: 'STRING' }
          },
          required: ['low', 'high', 'unit', 'confidence']
        },
        estimatedValue: {
          type: 'OBJECT',
          properties: {
            low: { type: 'NUMBER' }, high: { type: 'NUMBER' }, confidence: { type: 'STRING' }
          },
          required: ['low', 'high', 'confidence']
        },
        rental: {
          type: 'OBJECT',
          properties: {
            monthlyLow: { type: 'NUMBER' }, monthlyHigh: { type: 'NUMBER' }, yieldLow: { type: 'NUMBER' }, yieldHigh: { type: 'NUMBER' }, confidence: { type: 'STRING' }
          },
          required: ['monthlyLow', 'monthlyHigh', 'yieldLow', 'yieldHigh', 'confidence']
        },
        appreciation: {
          type: 'OBJECT',
          properties: {
            fiveYearLow: { type: 'NUMBER' }, fiveYearBase: { type: 'NUMBER' }, fiveYearHigh: { type: 'NUMBER' }, confidence: { type: 'STRING' }
          },
          required: ['fiveYearLow', 'fiveYearBase', 'fiveYearHigh', 'confidence']
        },
        comparables: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              location: { type: 'STRING' },
              pricePerSqft: { type: 'NUMBER' },
              relevance: { type: 'STRING', enum: ['same_project', 'same_micro_market', 'similar_project', 'other'] },
              sourceTitle: { type: 'STRING' },
              sourceUrl: { type: 'STRING' },
              evidenceDate: { type: 'STRING' }
            },
            required: ['name', 'location', 'pricePerSqft', 'relevance', 'sourceTitle', 'sourceUrl', 'evidenceDate']
          }
        },
        score: { type: 'NUMBER' },
        verdict: { type: 'STRING', enum: ['BUY', 'NEGOTIATE', 'WATCH', 'AVOID'] },
        profile: { type: 'STRING' },
        breakEvenAppreciation: { type: 'NUMBER', nullable: true },
        metrics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, score: { type: 'NUMBER' } }, required: ['label', 'score'] } },
        strengths: { type: 'ARRAY', items: { type: 'STRING' } },
        risks: { type: 'ARRAY', items: { type: 'STRING' } },
        scenarios: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, appreciation: { type: 'STRING' }, comment: { type: 'STRING' } }, required: ['name', 'appreciation', 'comment'] } },
        recommendation: { type: 'STRING' },
        sources: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, url: { type: 'STRING' } }, required: ['title', 'url'] } },
        dataGaps: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['propertyName','developer','locationSummary','marketPricePerSqft','estimatedValue','rental','appreciation','comparables','score','verdict','profile','breakEvenAppreciation','metrics','strengths','risks','scenarios','recommendation','sources','dataGaps']
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
        })
      });
    } finally { clearTimeout(timeout); }

    let raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }

    if (response.status === 429) {
      console.warn('PropertyIQ grounding quota unavailable; retrying without Google Search grounding.');
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + encodeURIComponent(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nGoogle Search grounding is unavailable for this request. Do not claim to have searched the web, do not invent source URLs, and explicitly list missing live-market information in dataGaps.` }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
        })
      });
      raw = await response.text();
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }

    if (!response.ok) {
      const message = payload?.error?.message || raw.slice(0, 500) || 'Gemini request failed.';
      console.error('PropertyIQ Gemini error', response.status, message);
      return res.status(502).json({ error: `AI research failed (${response.status}): ${message}` });
    }

    const text = payload?.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text || '';
    if (!text) return res.status(502).json({ error: 'Gemini returned an empty research response. Please try again.' });

    let result;
    try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Gemini returned an invalid structured result. Please try again.' }); }

    const valuation = deterministicValuation(result, body);
    if (valuation) {
      result.marketPricePerSqft = {
        low: valuation.lowRatePerSqft,
        high: valuation.highRatePerSqft,
        unit: 'INR/sq.ft.',
        confidence: valuation.confidence
      };
      if (valuation.estimatedValueLow != null && valuation.estimatedValueHigh != null) {
        result.estimatedValue = {
          low: valuation.estimatedValueLow,
          high: valuation.estimatedValueHigh,
          confidence: valuation.confidence
        };
      }
      result.valuationMethod = valuation;
    } else {
      result.valuationMethod = {
        method: 'Evidence unavailable',
        confidence: 'Low',
        comparablesUsed: 0,
        dataGap: 'No valid comparable price evidence with source URLs was returned.'
      };
    }

    result.analysisId = analysisId;
    result.researchedAt = new Date().toISOString();

    try {
      await storeAnalysis(analysisId, body, result, valuation);
    } catch (storageError) {
      console.error('PropertyIQ analysis storage error', storageError?.message);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('PropertyIQ request error', error?.name, error?.message);
    if (error?.name === 'AbortError') return res.status(504).json({ error: 'PropertyIQ research timed out. Please try again.' });
    return res.status(500).json({ error: `PropertyIQ could not complete the research: ${error?.message || 'Unknown error'}` });
  }
};
