/* USD<->AMD exchange rate. Free source: open.er-api.com (no key).
   Cached in the Airtable `meta` table for 24h. */
const https = require('https');
const at = require('./airtable');

function fetchRate() {
  return new Promise((resolve, reject) => {
    https.get('https://open.er-api.com/v6/latest/USD', (resp) => {
      let raw = '';
      resp.on('data', (c) => (raw += c));
      resp.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const amd = j && j.rates && j.rates.AMD;
          if (!amd) throw new Error('no AMD rate');
          resolve({ rate: amd, at: new Date().toISOString() });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getRate() {
  try {
    const rows = await at.list('meta', { filterByFormula: `{key}='usd_amd'`, maxRecords: 1 });
    const rec = rows.records && rows.records[0];
    if (rec) {
      const age = Date.now() - new Date(rec.fields.updated_at).getTime();
      if (age < 24 * 3600e3 && rec.fields.value) {
        return { rate: parseFloat(rec.fields.value), at: rec.fields.updated_at, cached: true };
      }
    }
    const fresh = await fetchRate();
    const fields = { key: 'usd_amd', value: String(fresh.rate), updated_at: fresh.at };
    if (rec) await at.update('meta', rec.id, fields);
    else await at.create('meta', fields);
    return { ...fresh, cached: false };
  } catch (e) {
    // Last-resort fallback so the site never breaks on FX failure.
    return { rate: 400, at: null, cached: false, fallback: true };
  }
}

module.exports = { getRate };
