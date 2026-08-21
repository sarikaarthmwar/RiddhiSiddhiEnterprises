export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'PropertyIQ AI is not configured yet. Add OPENAI_API_KEY in Vercel Environment Variables.' });

  try {
    const body = req.body || {};
    const { project, location, propertyType, area, price, listingUrl } = body;
    if (!project || !location || !price) return res.status(400).json({ error: 'Project, location and quoted price are required.' });

    const prompt = `You are PropertyIQ, an evidence-led real-estate investment analyst focused on India. Research this property using current web information and return ONLY valid JSON.

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
6. Identify material risks. Never invent facts; mark unknowns.
7. Score valuation, rental economics, growth, liquidity and risk into PropertyIQ 0-100 and verdict BUY, NEGOTIATE, WATCH or AVOID.
8. Calculate break-even appreciation versus a 10% alternative return only when enough inputs exist; otherwise null.
9. Give downside, base and upside appreciation ranges.
10. Return only source URLs actually used; never fabricate URLs.

Keep narrative fields concise and arrays to the most useful 3-5 items so the response stays compact.

Return exactly this JSON shape:
{
  "propertyName":"",
  "developer":"",
  "locationSummary":"",
  "marketPricePerSqft":{"low":0,"high":0,"unit":"INR/sq.ft.","confidence":"High|Medium|Low"},
  "estimatedValue":{"low":0,"high":0,"confidence":"High|Medium|Low"},
  "rental":{"monthlyLow":0,"monthlyHigh":0,"yieldLow":0,"yieldHigh":0,"confidence":"High|Medium|Low"},
  "appreciation":{"fiveYearLow":0,"fiveYearBase":0,"fiveYearHigh":0,"confidence":"High|Medium|Low"},
  "score":0,
  "verdict":"BUY|NEGOTIATE|WATCH|AVOID",
  "profile":"",
  "breakEvenAppreciation":0,
  "metrics":[{"label":"Valuation","score":0},{"label":"Rental demand","score":0},{"label":"Growth potential","score":0},{"label":"Liquidity","score":0},{"label":"Risk","score":0}],
  "strengths":[""],
  "risks":[""],
  "scenarios":[{"name":"Downside","appreciation":"","comment":""},{"name":"Base case","appreciation":"","comment":""},{"name":"Upside","appreciation":"","comment":""}],
  "recommendation":"",
  "sources":[{"title":"","url":""}],
  "dataGaps":[""]
}`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.PROPERTYIQ_MODEL || 'gpt-5.6-luna',
        reasoning: { effort: 'low' },
        tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'IN', region: 'Maharashtra', city: 'Pune', timezone: 'Asia/Kolkata' } }],
        input: prompt
      })
    });

    const payload = await response.json();
    if (!response.ok) return res.status(502).json({ error: payload?.error?.message || 'AI research request failed.' });
    const text = payload.output_text || '';
    const cleaned = text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
    const result = JSON.parse(cleaned);
    result.researchedAt = new Date().toISOString();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: 'PropertyIQ could not complete the research. Please try again.', detail: error.message });
  }
}
