const ALLOWED_EVENTS = new Set(['analysis_started', 'analysis_completed', 'lead_submitted', 'result_viewed']);
const RETENTION_SECONDS = 60 * 60 * 24 * 365;
const MAX_EVENTS = 5000;

function json(res, status, body) { res.status(status).json(body); }
function cleanText(value, max = 80) { return typeof value === 'string' ? value.trim().replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, max) : ''; }
function storageUrl() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function storageToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvEnabled() { return Boolean(storageUrl() && storageToken()); }

async function kvPipeline(commands) {
  const response = await fetch(storageUrl() + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + storageToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('Analytics storage request failed.');
  return response.json();
}

async function getAnalysis(analysisId) {
  const rows = await kvPipeline([['GET', 'propertyiq:analysis:' + analysisId]]);
  const value = rows?.[0]?.result;
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

// The PropertyIQ page historically generated a browser UUID for analytics but
// did not send that UUID to /api/propertyiq. The full analysis was therefore
// stored under a separate piq-* ID. Recover that link for existing records and
// create an alias so the dashboard can retrieve the exact response by its
// analytics Analysis ID.
async function findStoredAnalysisForEvent(event) {
  let cursor = '0';
  const candidates = [];
  for (let page = 0; page < 5; page += 1) {
    const rows = await kvPipeline([['SCAN', cursor, 'MATCH', 'propertyiq:analysis:*', 'COUNT', 500]]);
    const result = rows?.[0]?.result || [];
    cursor = String(result[0] ?? '0');
    const keys = result[1] || [];
    if (keys.length) {
      const values = await kvPipeline(keys.map((key) => ['GET', key]));
      values.forEach((row) => {
        const raw = row?.result;
        if (!raw) return;
        try {
          const record = JSON.parse(raw);
          const input = record.input || {};
          const sameLocation = cleanText(input.location, 80).toLowerCase() === cleanText(event.location, 80).toLowerCase();
          const sameType = cleanText(input.propertyType, 50).toLowerCase() === cleanText(event.propertyType, 50).toLowerCase();
          const sameScore = Number(record.analysis?.score) === Number(event.score);
          const ageMs = Math.abs(Number(record.createdAtMs || 0) - Number(event.createdAtMs || 0));
          if (sameLocation && sameType && sameScore && ageMs <= 10 * 60 * 1000) candidates.push({ record, ageMs });
        } catch (_) {}
      });
    }
    if (cursor === '0') break;
  }
  candidates.sort((a, b) => a.ageMs - b.ageMs);
  return candidates[0]?.record || null;
}

async function linkAnalysisToEvent(event) {
  const direct = await getAnalysis(event.analysisId);
  if (direct) return direct;
  if (event.eventType !== 'analysis_completed') return null;
  const matched = await findStoredAnalysisForEvent(event);
  if (!matched) return null;
  const aliasRecord = { ...matched, analyticsAnalysisId: event.analysisId };
  await kvPipeline([['SET', 'propertyiq:analysis:' + event.analysisId, JSON.stringify(aliasRecord), 'EX', RETENTION_SECONDS]]);
  return aliasRecord;
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
  const locations = {}, propertyTypes = {}, intents = {}, scores = Array(5).fill(0), trend = {};
  completed.forEach((event) => {
    const day = new Date(event.createdAtMs).toISOString().slice(0, 10);
    trend[day] = (trend[day] || 0) + 1;
    if (event.location) locations[event.location] = (locations[event.location] || 0) + 1;
    if (event.propertyType) propertyTypes[event.propertyType] = (propertyTypes[event.propertyType] || 0) + 1;
    if (event.investmentIntent) intents[event.investmentIntent] = (intents[event.investmentIntent] || 0) + 1;
    if (Number.isFinite(event.score)) scores[Math.min(4, Math.floor(event.score / 20))] += 1;
  });
  const sortCounts = (object) => Object.entries(object).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return {
    totalAnalyses: completed.length,
    leadsGenerated: leads.length,
    conversionRate: completed.length ? Math.round((leads.length / completed.length) * 1000) / 10 : 0,
    averageScore: completed.length ? Math.round(completed.reduce((sum, event) => sum + (Number(event.score) || 0), 0) / completed.length) : null,
    propertyTypes: sortCounts(propertyTypes), intents: sortCounts(intents), locations: sortCounts(locations).slice(0, 8),
    scoreDistribution: [
      { label: '0–19', value: scores[0] }, { label: '20–39', value: scores[1] }, { label: '40–59', value: scores[2] },
      { label: '60–79', value: scores[3] }, { label: '80–100', value: scores[4] }
    ],
    trend: Object.entries(trend).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value })),
    recent: completed.slice(-8).reverse().map((event) => ({ propertyType: event.propertyType || 'Property', location: event.location || 'Location not shared', score: Number.isFinite(event.score) ? event.score : null, createdAt: event.createdAtMs })),
    analyses: completed.slice().sort((a, b) => b.createdAtMs - a.createdAtMs).map((event) => ({ analysisId: event.analysisId, eventType: event.eventType, propertyType: event.propertyType || 'Property', location: event.location || 'Location not shared', investmentIntent: event.investmentIntent || 'Not specified', score: Number.isFinite(event.score) ? event.score : null, createdAt: event.createdAtMs }))
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!kvEnabled()) return json(res, 503, { error: 'Analytics storage is not configured.', configured: false });
  try {
    if (req.method === 'POST') {
      const body = req.body || {}, eventType = body.eventType, analysisId = cleanText(body.analysisId, 100);
      if (!ALLOWED_EVENTS.has(eventType) || !/^[a-zA-Z0-9_-]{12,100}$/.test(analysisId)) return json(res, 400, { error: 'Invalid analytics event.' });
      const event = { eventType, analysisId, createdAtMs: Date.now(), propertyType: cleanText(body.propertyType, 50), location: cleanText(body.location, 80), investmentIntent: cleanText(body.investmentIntent, 50), score: Number.isFinite(Number(body.score)) ? Math.max(0, Math.min(100, Math.round(Number(body.score)))) : null };
      const result = await recordEvent(event);
      if (eventType === 'analysis_completed' && !result.duplicate) {
        try { await linkAnalysisToEvent(event); } catch (linkError) { console.warn('PropertyIQ analysis linkage warning', linkError?.message); }
      }
      return json(res, 202, { accepted: true, duplicate: result.duplicate });
    }
    if (req.method === 'GET') {
      const requestedAnalysisId = cleanText(req.query?.analysisId, 100);
      if (requestedAnalysisId) {
        const analysis = await getAnalysis(requestedAnalysisId);
        if (!analysis) return json(res, 404, { error: 'Analysis not found.' });
        return json(res, 200, { configured: true, analysis });
      }
      const range = ['today', '7d', '30d', 'all'].includes(req.query?.range) ? req.query.range : '30d';
      const now = Date.now();
      const start = range === 'today' ? new Date(new Date().toDateString()).getTime() : range === '7d' ? now - 7 * 86400000 : range === '30d' ? now - 30 * 86400000 : 0;
      const rows = await kvPipeline([['ZRANGEBYSCORE', 'propertyiq:events', start, '+inf', 'LIMIT', 0, MAX_EVENTS]]);
      const events = (rows?.[0]?.result || []).map((value) => { try { return JSON.parse(value); } catch (_) { return null; } }).filter(Boolean);
      return json(res, 200, { configured: true, range, generatedAt: new Date().toISOString(), ...metrics(events) });
    }
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('PropertyIQ analytics error', error?.message);
    return json(res, 503, { error: 'Analytics are temporarily unavailable.' });
  }
};