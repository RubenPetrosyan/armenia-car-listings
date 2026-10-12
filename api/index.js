/* Armenia car listings API — Vercel serverless.
   DB: Airtable. Auth: Firebase ID tokens (verified via Google certs, no admin SDK). */
const at = require('./_lib/airtable');
const { verifyIdToken } = require('./_lib/auth');
const { getRate } = require('./_lib/fx');
const makes = require('./_lib/makes');

const CHUNK = 32000;
const MAX_PHOTOS = 6;

const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 25 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try { return await verifyIdToken(m[1]); } catch (e) { return null; }
}

async function ensureUser(fb) {
  const rows = await at.list('users', { filterByFormula: `{firebase_uid}='${at.esc(fb.uid)}'`, maxRecords: 1 });
  if (rows.records && rows.records[0]) {
    const f = rows.records[0].fields;
    // keep email/phone fresh
    const upd = {};
    if (fb.email && f.email !== fb.email) upd.email = fb.email;
    if (fb.phone && f.phone !== fb.phone) upd.phone = fb.phone;
    if (Object.keys(upd).length) await at.update('users', rows.records[0].id, upd);
    return { id: rows.records[0].id, ...rows.records[0].fields, ...upd };
  }
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = fb.email && adminEmails.includes(fb.email.toLowerCase());
  const rec = await at.create('users', {
    firebase_uid: fb.uid,
    email: fb.email || '',
    phone: fb.phone || '',
    name: '',
    is_admin: !!isAdmin,
    created_at: new Date().toISOString(),
  });
  return { id: rec.id, ...rec.fields };
}

function publicListing(r) {
  const f = r.fields;
  let photos = [];
  try { photos = JSON.parse(f.photo_ids || '[]'); } catch (e) {}
  return {
    id: f.id, title: f.title, make: f.make, model: f.model, year: f.year,
    price_usd: f.price_usd, price_amd: f.price_amd,
    mileage: f.mileage, mileage_unit: f.mileage_unit,
    body_type: f.body_type, fuel: f.fuel, gearbox: f.gearbox, drive: f.drive,
    color: f.color, description: f.description, youtube_url: f.youtube_url,
    photos, status: f.status, views: f.views || 0,
    seller_uid: f.seller_uid, created_at: f.created_at, updated_at: f.updated_at,
  };
}

async function storePhotos(listingId, photos) {
  const ids = [];
  for (let i = 0; i < Math.min(photos.length, MAX_PHOTOS); i++) {
    const p = photos[i];
    if (!p.data || p.data.length > 4 * 1024 * 1024) continue;
    const file = await at.create('files', {
      id: `${listingId}_${i}_${Date.now()}`,
      listing_id: listingId, idx: i,
      name: (p.name || `photo${i + 1}.jpg`).slice(0, 120),
      mime: p.mime || 'image/jpeg', size: p.data.length,
      created_at: new Date().toISOString(),
    });
    const fid = file.fields.id;
    for (let c = 0; c * CHUNK < p.data.length; c++) {
      await at.create('file_chunks', { file_id: fid, idx: c, data: p.data.slice(c * CHUNK, (c + 1) * CHUNK) });
    }
    ids.push(fid);
  }
  return ids;
}

async function deletePhotos(photoIds) {
  for (const fid of photoIds) {
    const chunks = await at.listAll('file_chunks', { filterByFormula: `{file_id}='${at.esc(fid)}'` });
    for (const c of chunks) await at.del('file_chunks', c.id).catch(() => {});
    const files = await at.list('files', { filterByFormula: `{id}='${at.esc(fid)}'`, maxRecords: 1 });
    if (files.records && files.records[0]) await at.del('files', files.records[0].id).catch(() => {});
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api/, '') || '/';

  try {
    // ---- public config ----
    if (path === '/config' && req.method === 'GET') {
      return json(res, 200, {
        firebase: {
          apiKey: process.env.FIREBASE_API_KEY || '',
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
          projectId: process.env.FIREBASE_PROJECT_ID || '',
        },
        maxPhotos: MAX_PHOTOS,
      });
    }
    if (path === '/fx' && req.method === 'GET') return json(res, 200, await getRate());
    if (path === '/makes' && req.method === 'GET') return json(res, 200, { makes });

    // ---- photo serve ----
    let m = path.match(/^\/photo\/([\w\-.]+)$/);
    if (m && req.method === 'GET') {
      const fid = m[1];
      const files = await at.list('files', { filterByFormula: `{id}='${at.esc(fid)}'`, maxRecords: 1 });
      if (!files.records || !files.records[0]) { res.statusCode = 404; res.end(); return; }
      const meta = files.records[0].fields;
      const chunks = await at.listAll('file_chunks', {
        filterByFormula: `{file_id}='${at.esc(fid)}'`, sort: [{ field: 'idx', direction: 'asc' }],
      });
      const b64 = chunks.map((c) => c.fields.data).join('');
      const buf = Buffer.from(b64, 'base64');
      res.statusCode = 200;
      res.setHeader('Content-Type', meta.mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(buf);
      return;
    }

    // ---- listings search (public) ----
    if (path === '/listings' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const make = url.searchParams.get('make') || '';
      const model = url.searchParams.get('model') || '';
      const minY = parseInt(url.searchParams.get('min_year') || '0', 10);
      const maxY = parseInt(url.searchParams.get('max_year') || '9999', 10);
      const maxP = parseFloat(url.searchParams.get('max_price') || '0');
      const conds = [`{status}='active'`];
      if (make) conds.push(`{make}='${at.esc(make)}'`);
      if (model) conds.push(`FIND(LOWER('${at.esc(model)}'), LOWER({model}))`);
      if (minY) conds.push(`{year}>=${minY}`);
      if (maxY < 9999) conds.push(`{year}<=${maxY}`);
      if (maxP) conds.push(`{price_usd}<=${maxP}`);
      if (q) {
        const qq = at.esc(q.toLowerCase());
        conds.push(`OR(FIND('${qq}', LOWER({title})), FIND('${qq}', LOWER({description})))`);
      }
      const r = await at.list('listings', {
        filterByFormula: `AND(${conds.join(',')})`,
        sort: [{ field: 'created_at', direction: 'desc' }],
        pageSize: 24,
        offset: url.searchParams.get('offset') || undefined,
      });
      return json(res, 200, {
        listings: (r.records || []).map(publicListing),
        offset: r.offset || null,
      });
    }

    // ---- listing detail (public) ----
    m = path.match(/^\/listings\/([\w\-.]+)$/);
    if (m && req.method === 'GET') {
      const rows = await at.list('listings', { filterByFormula: `{id}='${at.esc(m[1])}'`, maxRecords: 1 });
      if (!rows.records || !rows.records[0]) return json(res, 404, { error: 'not found' });
      const rec = rows.records[0];
      if (rec.fields.status !== 'active') return json(res, 404, { error: 'not found' });
      at.update('listings', rec.id, { views: (rec.fields.views || 0) + 1 }).catch(() => {});
      return json(res, 200, { listing: publicListing(rec) });
    }

    // ---- create listing (auth) ----
    if (path === '/listings' && req.method === 'POST') {
      const fb = await authUser(req);
      if (!fb) return json(res, 401, { error: 'auth required' });
      const user = await ensureUser(fb);
      const b = await readBody(req);
      if (!b.title || !b.make || !b.price_usd) return json(res, 400, { error: 'title, make, price required' });
      const { rate } = await getRate();
      const id = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const rec = await at.create('listings', {
        id, seller_uid: fb.uid,
        title: String(b.title).slice(0, 140), make: String(b.make).slice(0, 60),
        model: String(b.model || '').slice(0, 60), year: parseInt(b.year, 10) || 0,
        price_usd: parseFloat(b.price_usd) || 0,
        price_amd: Math.round((parseFloat(b.price_usd) || 0) * rate),
        mileage: parseFloat(b.mileage) || 0, mileage_unit: b.mileage_unit === 'mi' ? 'mi' : 'km',
        body_type: String(b.body_type || '').slice(0, 40), fuel: String(b.fuel || '').slice(0, 30),
        gearbox: String(b.gearbox || '').slice(0, 30), drive: String(b.drive || '').slice(0, 20),
        color: String(b.color || '').slice(0, 30),
        description: String(b.description || '').slice(0, 4000),
        youtube_url: String(b.youtube_url || '').slice(0, 300),
        photo_ids: '[]', status: 'active', views: 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const photoIds = await storePhotos(id, b.photos || []);
      await at.update('listings', rec.id, { photo_ids: JSON.stringify(photoIds) });
      return json(res, 200, { ok: true, id });
    }

    // ---- update / delete listing (owner or admin) ----
    if (m && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const fb = await authUser(req);
      if (!fb) return json(res, 401, { error: 'auth required' });
      const user = await ensureUser(fb);
      const rows = await at.list('listings', { filterByFormula: `{id}='${at.esc(m[1])}'`, maxRecords: 1 });
      if (!rows.records || !rows.records[0]) return json(res, 404, { error: 'not found' });
      const rec = rows.records[0];
      if (rec.fields.seller_uid !== fb.uid && !user.is_admin) return json(res, 403, { error: 'forbidden' });
      if (req.method === 'DELETE') {
        let photos = [];
        try { photos = JSON.parse(rec.fields.photo_ids || '[]'); } catch (e) {}
        await deletePhotos(photos);
        await at.del('listings', rec.id);
        return json(res, 200, { ok: true });
      }
      const b = await readBody(req);
      const upd = { updated_at: new Date().toISOString() };
      for (const k of ['title', 'make', 'model', 'body_type', 'fuel', 'gearbox', 'drive', 'color', 'description', 'youtube_url', 'status']) {
        if (b[k] !== undefined) upd[k] = String(b[k]).slice(0, k === 'description' ? 4000 : 140);
      }
      if (b.year !== undefined) upd.year = parseInt(b.year, 10) || 0;
      if (b.mileage !== undefined) upd.mileage = parseFloat(b.mileage) || 0;
      if (b.price_usd !== undefined) {
        upd.price_usd = parseFloat(b.price_usd) || 0;
        const { rate } = await getRate();
        upd.price_amd = Math.round(upd.price_usd * rate);
      }
      await at.update('listings', rec.id, upd);
      return json(res, 200, { ok: true });
    }

    // ---- me ----
    if (path === '/me' && req.method === 'GET') {
      const fb = await authUser(req);
      if (!fb) return json(res, 401, { error: 'auth required' });
      const user = await ensureUser(fb);
      const mine = await at.listAll('listings', { filterByFormula: `{seller_uid}='${at.esc(fb.uid)}'` });
      return json(res, 200, {
        user: { email: user.email, phone: user.phone, name: user.name, is_admin: !!user.is_admin, created_at: user.created_at },
        listings: mine.map(publicListing),
      });
    }

    // ---- admin ----
    if (path.startsWith('/admin/')) {
      const fb = await authUser(req);
      if (!fb) return json(res, 401, { error: 'auth required' });
      const user = await ensureUser(fb);
      if (!user.is_admin) return json(res, 403, { error: 'admin only' });
      if (path === '/admin/users' && req.method === 'GET') {
        const users = await at.listAll('users', { sort: [{ field: 'created_at', direction: 'desc' }] });
        const listings = await at.listAll('listings');
        const counts = {};
        for (const l of listings) {
          const u = l.fields.seller_uid;
          counts[u] = (counts[u] || 0) + 1;
        }
        return json(res, 200, {
          users: users.map((u) => ({
            email: u.fields.email, phone: u.fields.phone, name: u.fields.name,
            is_admin: !!u.fields.is_admin, created_at: u.fields.created_at,
            listings: counts[u.fields.firebase_uid] || 0,
          })),
        });
      }
      if (path === '/admin/stats' && req.method === 'GET') {
        const users = await at.listAll('users');
        const listings = await at.listAll('listings');
        const active = listings.filter((l) => l.fields.status === 'active').length;
        return json(res, 200, { users: users.length, listings: listings.length, active });
      }
      return json(res, 404, { error: 'not found' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'server error' });
  }
};
