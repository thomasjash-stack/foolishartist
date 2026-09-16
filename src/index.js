/**
 * Bright Legal conveyancing estimates.
 *
 * One Worker does three jobs:
 *   1. serves the public tool at  /
 *   2. serves the internal tool at /internal  (protect this with Cloudflare Access)
 *   3. accepts POST /api/estimate, writes the estimate to D1, and hands the
 *      public ones to Zapier for emailing
 *
 * Secrets, set with `npx wrangler secret put NAME`:
 *   TURNSTILE_SECRET   from the Turnstile widget (public build only)
 *   ZAPIER_HOOK        the catch hook URL, kept server side so it is not in page source
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Only our own origins may post here.
const ALLOWED_ORIGINS = [
  'https://estimates.brightlegal.co.uk',
  'https://www.brightlegal.co.uk',
  'https://brightlegal.co.uk'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

/** Cloudflare Turnstile. Returns true when the visitor looks human. */
async function turnstileOk(token, secret, ip) {
  if (!secret) return true;              // not configured yet, do not block
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form }
  );
  const out = await res.json();
  return out.success === true;
}

/** Keep the payload to sane sizes so nobody can stuff the database. */
const str = (v, max = 400) =>
  v == null ? null : String(v).slice(0, max);
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function handleEstimate(request, env, ctx) {
  const cors = corsHeaders(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Malformed request' }, 400, cors);
  }

  const isInternal = body.mode === 'internal';

  // The public form must pass Turnstile. The internal one sits behind
  // Cloudflare Access, which has already established who the user is.
  if (!isInternal) {
    const ok = await turnstileOk(
      body.turnstileToken,
      env.TURNSTILE_SECRET,
      request.headers.get('CF-Connecting-IP')
    );
    if (!ok) return json({ ok: false, error: 'Verification failed' }, 403, cors);
  }

  const c = body.client   || {};
  const m = body.matter   || {};
  const f = body.figures  || {};
  const n = body.internal || {};

  if (f.total == null) {
    return json({ ok: false, error: 'No figures supplied' }, 400, cors);
  }

  const id = str(body.reference, 40) || crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO estimates (
        id, created_at, mode, matter_type,
        first_name, last_name, other_names, email, phone, clients,
        property_address, price, tenure, mortgaged, debt, payout, higher_rate_sdlt,
        answers, lines, net, vat, total,
        matter_ref, fee_earner, scale_fee, override_fee, override_reason,
        country
      ) VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?)
    `).bind(
      id, now, str(body.mode, 12), str(m.type, 40),
      str(c.firstName, 80), str(c.lastName, 80), str(c.otherNames, 300),
      str(c.email, 160), str(c.phone, 40), num(c.clients),
      str(m.address, 300), num(m.price), str(m.tenure, 20), str(m.mortgaged, 8),
      num(m.debt), num(m.payout), m.higherRateSdlt ? 1 : 0,
      JSON.stringify(m.answers || {}).slice(0, 4000),
      JSON.stringify(f.lines   || []).slice(0, 20000),
      num(f.net), num(f.vat), num(f.total),
      str(n.matterRef, 80), str(n.feeEarner, 80),
      num(n.scaleFee), num(n.overrideFee), str(n.overrideReason, 500),
      request.cf?.country || null
    ).run();
  } catch (err) {
    // A failed write must not silently lose the estimate.
    return json({ ok: false, error: 'Could not save: ' + err.message }, 500, cors);
  }

  // Internal estimates are recorded, not emailed.
  if (isInternal) return json({ ok: true, id, saved: true, emailed: false }, 200, cors);

  if (!env.ZAPIER_HOOK) {
    return json({ ok: true, id, saved: true, emailed: false,
                  note: 'Saved. Email delivery is not connected yet.' }, 200, cors);
  }

  // Hand off to Zapier server to server, where CORS does not apply.
  // waitUntil so a slow Zapier does not hold up the client's response.
  ctx.waitUntil((async () => {
    try {
      await fetch(env.ZAPIER_HOOK, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, id })
      });
      await env.DB.prepare('UPDATE estimates SET emailed_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), id).run();
    } catch (_) { /* the estimate is already saved; email can be retried */ }
  })());

  return json({ ok: true, id, saved: true, emailed: true }, 200, cors);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/estimate') {
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      if (request.method !== 'POST')
        return json({ ok: false, error: 'Method not allowed' }, 405, corsHeaders(request));
      return handleEstimate(request, env, ctx);
    }

    // Everything else is a static file: the two builds of the tool.
    return env.ASSETS.fetch(request);
  }
};
