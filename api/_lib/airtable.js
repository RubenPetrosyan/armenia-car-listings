/* Minimal Airtable helper for the Armenia car listings backend.
   Auth: on Vercel uses AIRTABLE_API_KEY env (Bearer); locally falls back to
   the platform-injected custom.airtable credential via surrogate. */
const BASE = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;

function attachAuth(options) {
  if (API_KEY) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${API_KEY}`;
    return null;
  }
  const { add_surrogate_to_request } =
    require('/opt/hatch/skills/skill-creator/bin/dynamic_credentials');
  return (req) => add_surrogate_to_request(req, 'custom.airtable', ['api.airtable.com']);
}

function req(method, path, data) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'api.airtable.com',
      path: `/v0${path}`,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const applySurrogate = attachAuth(options);
    const r = https.request(options, (resp) => {
      let raw = '';
      resp.on('data', (c) => (raw += c));
      resp.on('end', () => {
        let j = null;
        try { j = raw ? JSON.parse(raw) : null; } catch (e) { /* keep raw */ }
        if (resp.statusCode >= 400) {
          reject(new Error(`Airtable ${resp.statusCode}: ${String(raw).slice(0, 300)}`));
        } else resolve(j);
      });
    });
    r.on('error', reject);
    if (applySurrogate) applySurrogate(r);
    if (body) r.write(body);
    r.end();
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "\\'");

async function listAll(table, params = {}) {
  const out = [];
  let offset;
  do {
    const p = { ...params, pageSize: 100 };
    if (offset) p.offset = offset;
    const r = await module.exports.list(table, p);
    out.push(...(r.records || []));
    offset = r.offset;
  } while (offset);
  return out;
}

module.exports = {
  BASE,
  esc,
  listAll,
  list(table, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const qs = q.toString();
    return req('GET', `/${BASE}/${encodeURIComponent(table)}${qs ? '?' + qs : ''}`);
  },
  create: (table, fields) => req('POST', `/${BASE}/${encodeURIComponent(table)}`, { fields }),
  update: (table, id, fields) => req('PATCH', `/${BASE}/${encodeURIComponent(table)}/${id}`, { fields }),
  del: (table, id) => req('DELETE', `/${BASE}/${encodeURIComponent(table)}/${id}`),
  get: (table, id) => req('GET', `/${BASE}/${encodeURIComponent(table)}/${id}`),
};
