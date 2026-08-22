const ALLOWED_EVENTS = new Set(['analysis_started', 'analysis_completed', 'lead_submitted', 'result_viewed']);
const RETENTION_SECONDS = 60 * 60 * 24 * 365;
const MAX_EVENTS = 5000;

function json(res, status, body) {
  res.status(status).json(body);
}

function cleanText(value, max = 80) {
  return typeof value === 'string'
    ? value.trim().replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, max)
    : '';
}

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
  if (!response.ok) throw new Error('Analytics storage request failed.');
  return response.json();
}

async function recordEvent(event) {
  const dedupeKey = 'propertyiq:event:' + event.analysisId + ':' + event.eventType;
  const dedupe = await kvPipeline([['SET', dedupeKey, '1', 'NX', 'EX', RETENTION_SECONDS]]);
  if (dedupe?.[0]?.result !== 'OK') return { duplicate: true };

  const member = JSON.stringify(event);
  await kvPipeline([
    ['ZADD', 'propertyiq:events', event.createdAtMs, member],
    ['EXPIRE', 'propertyiq:events', RETENTION_SECONDS],
    ['ZREMRANGEBYSCORE', 'propertyiq:events', 0, Date.now() - RETENTION_SECONDS * 1000]
  ]);
  return { duplicate: false };
}

function metrics(events) {
  const completed = events.filter((event) => event.eventType === 'analysis_completed');
  const leads = events.filter((event) => event.eventType === 'lead_submitted');
  const locations = {};
  const propertyTypes = {};
  const intents = {};
  const scores = Array(5).fill(0);
  const trend = {};

  completed.forEach((event) => {
    const day = new Date(event.createdAtMs).toISOString().slice(0, 10);
    trend[day] = (trend[day] || 0) + 1;
    if (event.location) locations[event.location] = (locations[event.location] || 0) + 1;
    if (event.propertyType) propertyTypes[event.propertyType] = (propertyTypes[event.propertyType] || 0) + 1;
    if (event.investmentIntent) intents[event.investmentIntent] = (intents[event.investmentIntent] || 0) + 1;
    if (Number.isFinite(event.score)) scores[Math.min(4, Math.floor(event.score / 20))] += 1;
  });

  const sortCounts = (object) => Object.entries(object)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  return {
    totalAnalyses: completed.length,
    leadsGenerated: leads.length,
    conversionRate: completed.length ? Math.round((leads.length / completed.length) * 1000) / 10 : 0,
    averageScore: completed.length
      ? Math.round(completed.reduce((sum, event) => sum + (Number(event.score) || 0), 0) / completed.length)
      : null,
    propertyTypes: sortCounts(propertyTypes),
    intents: sortCounts(intents),
    locations: sortCounts(locations).slice(0, 8),
    scoreDistribution: [
      { label: '0–19', value: scores[0] }, { label: '20–39', value: scores[1] },
      { label: '40–59', value: scores[2] }, { label: '60–79', value: scores[3] },
      { label: '80–100', value: scores[4] }
    ],
    trend: Object.entries(trend).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value })),
    recent: completed.slice(-8).reverse().map((event) => ({
      propertyType: event.propertyType || 'Property',
      location: event.location || 'Location not shared',
      score: Number.isFinite(event.score) ? event.score : null,
      createdAt: event.createdAtMs
    }))
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!kvEnabled()) {
    return json(res, 503, { error: 'Analytics storage is not configured.', configured: false });
  }

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const eventType = body.eventType;
      const analysisId = cleanText(body.analysisId, 100);
      if (!ALLOWED_EVENTS.has(eventType) || !/^[a-zA-Z0-9_-]{12,100}$/.test(analysisId)) {
        return json(res, 400, { error: 'Invalid analytics event.' });
      }

      const event = {
        eventType,
        analysisId,
        createdAtMs: Date.now(),
        propertyType: cleanText(body.propertyType, 50),
        location: cleanText(body.location, 80),
        investmentIntent: cleanText(body.investmentIntent, 50),
        score: Number.isFinite(Number(body.score)) ? Math.max(0, Math.min(100, Math.round(Number(body.score)))) : null
      };
      const result = await recordEvent(event);
      return json(res, 202, { accepted: true, duplicate: result.duplicate });
    }

    if (req.method === 'GET') {
      const range = ['today', '7d', '30d', 'all'].includes(req.query?.range) ? req.query.range : '30d';
      const now = Date.now();
      const start = range === 'today' ? new Date(new Date().toDateString()).getTime()
        : range === '7d' ? now - 7 * 86400000
        : range === '30d' ? now - 30 * 86400000 : 0;
      const rows = await kvPipeline([['ZRANGEBYSCORE', 'propertyiq:events', start, '+inf', 'LIMIT', 0, MAX_EVENTS]]);
      const events = (rows?.[0]?.result || []).map((value) => {
        try { return JSON.parse(value); } catch (_) { return null; }
      }).filter(Boolean);
      return json(res, 200, { configured: true, range, generatedAt: new Date().toISOString(), ...metrics(events) });
    }

    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('PropertyIQ analytics error', error?.message);
    return json(res, 503, { error: 'Analytics are temporarily unavailable.' });
  }
};