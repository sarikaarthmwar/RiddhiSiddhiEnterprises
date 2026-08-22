export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!apiKey) {
    return res.status(503).json({
      error: 'PropertyIQ AI Gateway is not configured. Add AI_GATEWAY_API_KEY in Vercel, or enable Vercel OIDC authentication.'
    });
  }

  try {
    const body = req.body || {};
    const { project, location, propertyType, area, price, listingUrl } = body;
    if (!project || !location || !price) {
      return res.status(400).json({ error: 'Project, location and quoted price are required.' });
    }

    const prompt = `You are PropertyIQ, an evidence-led real-estate investment analyst focused on India.
Research the property using current web information. Use the web search tool for current evidence.
Never invent facts or URLs. If evidence is unavailable, use null or an explicit data gap.
Keep all narrative fields concise and arrays to 3-5 useful items.

PROPERTY
Project: ${project}
Location: ${location}
Type: ${propertyType || 'Not specified'}
Area: ${area || 'Not specified'} sq.ft.
Quoted price: INR ${price}
Listing URL: ${listingUrl || 'Not provided'}

RESEARCH
1. Identify project/developer/location using official developer, RERA or government sources where available.
2. Estimate current market price/sq.ft. and a reasonable value range. Separate asking price from evidence.
3. Find comparable sale prices and rental evidence in the project/locality. Estimate monthly rent and yield.
4. Estimate a conservative 5-year annual appreciation range from current locality/project evidence. Never guarantee returns.
5. Assess rental demand, resale liquidity, supply, connectivity and demand drivers.
6. Identify material risks.
7. Score valuation, rental economics, growth, liquidity and risk into PropertyIQ 0-100 and verdict BUY, NEGOTIATE, WATCH or AVOID.
8. Calculate break-even appreciation versus a 10% alternative return only when enough inputs exist; otherwise null.
9. Give downside, base and upside appreciation ranges.
10. Return only source URLs actually used.

Return the requested structured object. Do not wrap it in markdown.`;

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        propertyName: { type: 'string' },
        developer: { type: 'string' },
        locationSummary: { type: 'string' },
        marketPricePerSqft: {
          type: 'object', additionalProperties: false,
          properties: { low: { type: 'number' }, high: { type: 'number' }, unit: { type: 'string' }, confidence: { type: 'string' } },
          required: ['low','high','unit','confidence']
        },
        estimatedValue: {
          type: 'object', additionalProperties: false,
          properties: { low: { type: 'number' }, high: { type: 'number' }, confidence: { type: 'string' } },
          required: ['low','high','confidence']
        },
        rental: {
          type: 'object', additionalProperties: false,
          properties: { monthlyLow: { type: 'number' }, monthlyHigh: { type: 'number' }, yieldLow: { type: 'number' }, yieldHigh: { type: 'number' }, confidence: { type: 'string' } },
          required: ['monthlyLow','monthlyHigh','yieldLow','yieldHigh','confidence']
        },
        appreciation: {
          type: 'object', additionalProperties: false,
          properties: { fiveYearLow: { type: 'number' }, fiveYearBase: { type: 'number' }, fiveYearHigh: { type: 'number' }, confidence: { type: 'string' } },
          required: ['fiveYearLow','fiveYearBase','fiveYearHigh','confidence']
        },
        score: { type: 'number' },
        verdict: { type: 'string', enum: ['BUY','NEGOTIATE','WATCH','AVOID'] },
        profile: { type: 'string' },
        breakEvenAppreciation: { type: ['number','null'] },
        metrics: {
          type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, score: { type: 'number' } }, required: ['label','score'] }
        },
        strengths: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        scenarios: {
          type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, appreciation: { type: 'string' }, comment: { type: 'string' } }, required: ['name','appreciation','comment'] }
        },
        recommendation: { type: 'string' },
        sources: {
          type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title','url'] }
        },
        dataGaps: { type: 'array', items: { type: 'string' } }
      },
      required: ['propertyName','developer','locationSummary','marketPricePerSqft','estimatedValue','rental','appreciation','score','verdict','profile','breakEvenAppreciation','metrics','strengths','risks','scenarios','recommendation','sources','dataGaps']
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const response = await fetch('https://ai-gateway.vercel.sh/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.PROPERTYIQ_MODEL || 'openai/gpt-5.6-luna',
        reasoning: { effort: 'low' },
        tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'IN', region: 'Maharashtra', city: 'Pune', timezone: 'Asia/Kolkata' } }],
        input: prompt,
        text: { format: { type: 'json_schema', name: 'propertyiq_result', schema } }
      })
    }).finally(() => clearTimeout(timeout));

    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || raw.slice(0, 500) || 'AI Gateway request failed.';
      console.error('PropertyIQ AI Gateway error', response.status, message);
      return res.status(502).json({ error: `AI research failed (${response.status}): ${message}` });
    }

    const text = payload?.output_text || payload?.output?.find(x => x.type === 'message')?.content?.find(x => x.type === 'output_text')?.text || '';
    if (!text) {
      console.error('PropertyIQ empty AI response', JSON.stringify(payload).slice(0, 2000));
      return res.status(502).json({ error: 'AI Gateway returned an empty research response. Please try again.' });
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch (parseError) {
      console.error('PropertyIQ JSON parse error', parseError.message, text.slice(0, 2000));
      return res.status(502).json({ error: 'AI research returned an invalid structured result. Please try again.' });
    }

    result.researchedAt = new Date().toISOString();
    return res.status(200).json(result);
  } catch (error) {
    console.error('PropertyIQ request error', error?.name, error?.message);
    if (error?.name === 'AbortError') return res.status(504).json({ error: 'PropertyIQ research timed out. Please try again.' });
    return res.status(500).json({ error: `PropertyIQ could not complete the research: ${error?.message || 'Unknown server error'}` });
  }
}
