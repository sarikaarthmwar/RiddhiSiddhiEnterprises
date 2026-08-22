# PropertyIQ analytics setup

PropertyIQ analytics is intentionally optional: property research and lead submission continue to work if analytics storage is unavailable.

## Required Vercel environment variables

Connect Upstash Redis through the Vercel Marketplace. It automatically adds these variables for Preview and Production:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The endpoint also accepts the legacy `KV_REST_API_URL` and `KV_REST_API_TOKEN` names if you already use them.

The analytics function stores only anonymous event data: event type, an opaque browser analysis ID, timestamp, property type, location, investment intent, and score. It never writes names, phone numbers, or email addresses.

## Routes

- `/propertyiq-dashboard` — aggregate-only dashboard
- `/api/propertyiq-analytics?range=today|7d|30d|all` — aggregate dashboard response
- `POST /api/propertyiq-analytics` — internal browser event tracking

The dashboard has no contact data and is safe to expose as an aggregate marketing page. If administrative access is added later, protect the dashboard route with the application's authentication layer rather than adding lead data to this endpoint.
