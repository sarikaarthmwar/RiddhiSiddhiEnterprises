export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'PropertyIQ is not configured. Add GEMINI_API_KEY in Vercel Environment Variables.' });
  }

  try {
    const body = req.body || {};
    const { project, location, propertyType, area, price, listingUrl } = body;
    if (!project || !location || !price) return res.status(400).json({ error: 'Project, location and quoted price are required.' });

    const prompt = `You are PropertyIQ, an evidence-led real-estate investment analyst focused on India.
Research the property using current web information and Google Search grounding. Never invent facts or URLs. If evidence is unavailable, use null or an explicit data gap.
Keep narrative concise and arrays to 3-5 useful items.
PROPERTY: Project=${project}; Location=${location}; Type=${propertyType || 'Not specified'}; Area=${area || 'Not specified'} sq.ft.; Quoted price=INR ${price}; Listing URL=${listingUrl || 'Not provided'}.
RESEARCH: identify project/developer/location using official developer, RERA or government sources where available; estimate current market price/sq.ft. and reasonable value range; find comparable sale prices and rental evidence; estimate rent and yield; estimate conservative 5-year annual appreciation range from evidence; assess rental demand, resale liquidity, supply, connectivity and demand drivers; identify material risks; score valuation, rental economics, growth, liquidity and risk into PropertyIQ 0-100 and verdict BUY, NEGOTIATE, WATCH or AVOID; calculate break-even appreciation versus a 10% alternative return only when enough inputs exist; give downside/base/upside appreciation ranges; return only source URLs actually used.
Return only the structured JSON object requested by the response schema.`;

    const schema = {
      type: 'OBJECT',
      properties: {
        propertyName: { type: 'STRING' }, developer: { type: 'STRING' }, locationSummary: { type: 'STRING' },
        marketPricePerSqft: { type: 'OBJECT', properties: { low: { type: 'NUMBER' }, high: { type: 'NUMBER' }, unit: { type: 'STRING' }, confidence: { type: 'STRING' } }, required: ['low','high','unit','confidence'] },
        estimatedValue: { type: 'OBJECT', properties: { low: { type: 'NUMBER' }, high: { type: 'NUMBER' }, confidence: { type: 'STRING' } }, required: ['low','high','confidence'] },
        rental: { type: 'OBJECT', properties: { monthlyLow: { type: 'NUMBER' }, monthlyHigh: { type: 'NUMBER' }, yieldLow: { type: 'NUMBER' }, yieldHigh: { type: 'NUMBER' }, confidence: { type: 'STRING' } }, required: ['monthlyLow','monthlyHigh','yieldLow','yieldHigh','confidence'] },
        appreciation: { type: 'OBJECT', properties: { fiveYearLow: { type: 'NUMBER' }, fiveYearBase: { type: 'NUMBER' }, fiveYearHigh: { type: 'NUMBER' }, confidence: { type: 'STRING' } }, required: ['fiveYearLow','fiveYearBase','fiveYearHigh','confidence'] },
        score: { type: 'NUMBER' }, verdict: { type: 'STRING', enum: ['BUY','NEGOTIATE','WATCH','AVOID'] }, profile: { type: 'STRING' }, breakEvenAppreciation: { type: 'NUMBER', nullable: true },
        metrics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, score: { type: 'NUMBER' } }, required: ['label','score'] } },
        strengths: { type: 'ARRAY', items: { type: 'STRING' } }, risks: { type: 'ARRAY', items: { type: 'STRING' } },
        scenarios: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, appreciation: { type: 'STRING' }, comment: { type: 'STRING' } }, required: ['name','appreciation','comment'] } },
        recommendation: { type: 'STRING' }, sources: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, url: { type: 'STRING' } }, required: ['title','url'] } }, dataGaps: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['propertyName','developer','locationSummary','marketPricePerSqft','estimatedValue','rental','appreciation','score','verdict','profile','breakEvenAppreciation','metrics','strengths','risks','scenarios','recommendation','sources','dataGaps']
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=' + encodeURIComponent(apiKey), {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema } })
      });
    } finally { clearTimeout(timeout); }

    const raw = await response.text();
    let payload; try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      const message = payload?.error?.message || raw.slice(0, 500) || 'Gemini request failed.';
      console.error('PropertyIQ Gemini error', response.status, message);
      return res.status(502).json({ error: `AI research failed (${response.status}): ${message}` });
    }
    const text = payload?.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text || '';
    if (!text) return res.status(502).json({ error: 'Gemini returned an empty research response. Please try again.' });
    let result; try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Gemini returned an invalid structured result. Please try again.' }); }
    result.researchedAt = new Date().toISOString();
    return res.status(200).json(result);
  } catch (error) {
    console.error('PropertyIQ request error', error?.name, error?.message);
    if (error?.name === 'AbortError') return res.status(504).json({ error: 'PropertyIQ research timed out. Please try again.' });
    return res.status(500).json({ error: `PropertyIQ could not complete the research: ${error?.message || 'Unknown server error'}` });
  }
}
