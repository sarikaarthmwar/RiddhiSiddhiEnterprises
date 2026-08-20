export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'PropertyIQ AI is not configured yet. Add OPENAI_API_KEY in Vercel Environment Variables.' });

  try {
    const body = req.body || {};
    const { project, location, propertyType, area, price, listingUrl } = body;
    if (!project || !location || !price) return res.status(400).json({ error: 'Project, location and quoted price are required.' });

    const prompt = `You are PropertyIQ, an evidence-led real-estate investment research analyst focused on India. Research the property opportunity below using current web information, then return ONLY valid JSON.

PROPERTY INPUT
Project: ${project}
Location: ${location}
Property type: ${propertyType || 'Not specified'}
Area: ${area || 'Not specified'} sq.ft.
Quoted price: INR ${price}
Listing URL: ${listingUrl || 'Not provided'}

RESEARCH REQUIREMENTS
1. Identify the project/developer and location. Prefer official developer/RERA/government sources where available.
2. Estimate current market price per sq.ft. and a reasonable market-value range for the supplied unit. Distinguish asking price from evidence-based estimates.
3. Research comparable sale prices and rental evidence in the same project/locality. Estimate realistic monthly rent and rental yield.
4. Research historical locality/project price trends and provide a conservative 5-year annual appreciation range. Never present appreciation as guaranteed.
5. Assess rental demand, resale liquidity, supply/competition, connectivity and major nearby demand drivers.
6. Identify important risks, including oversupply, execution/possession, legal/regulatory uncertainty, high entry price, weak yield or infrastructure dependence. Do not invent facts; mark unknowns.
7. Give a PropertyIQ score out of 100 and verdict: BUY, NEGOTIATE, WATCH or AVOID. The score must reflect valuation, rental economics, growth potential, liquidity and risk. It is decision support, not financial advice.
8. Calculate an indicative break-even appreciation rate versus a 10-year alternative investment return of 10% ONLY if enough inputs exist. Otherwise return null.
9. Give 3 scenarios: downside, base and upside with appreciation ranges, not point forecasts.
10. Include source URLs actually used. Do not fabricate URLs. If evidence is weak, say so.

Return this exact JSON shape:
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
        tools: [{ type: 'web_search', search_context_size: 'high', user_location: { type: 'approximate', country: 'IN', region: 'Maharashtra', city: 'Pune', timezone: 'Asia/Kolkata' } }],
        input: prompt,
        temperature: 0.1
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
