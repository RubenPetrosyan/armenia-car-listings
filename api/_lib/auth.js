/* Verify Firebase ID tokens without firebase-admin.
   Fetches Google's public certs, verifies RS256 signature + aud/iss/exp.
   Needs FIREBASE_PROJECT_ID env. No secrets required. */
const crypto = require('crypto');
const https = require('https');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
let certCache = null;
let certFetchedAt = 0;

function fetchCerts() {
  const now = Date.now();
  if (certCache && now - certFetchedAt < 3600e3) return Promise.resolve(certCache);
  return new Promise((resolve, reject) => {
    https.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', (resp) => {
      let raw = '';
      resp.on('data', (c) => (raw += c));
      resp.on('end', () => {
        try {
          certCache = JSON.parse(raw);
          certFetchedAt = now;
          resolve(certCache);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyIdToken(token) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, b, s] = parts;
  const header = JSON.parse(b64url(h).toString());
  const certs = await fetchCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error('unknown key id');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${b}`);
  const ok = verifier.verify(cert, b64url(s));
  if (!ok) throw new Error('bad signature');
  const payload = JSON.parse(b64url(b).toString());
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('bad audience');
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('bad issuer');
  if (!payload.sub) throw new Error('no subject');
  if (payload.exp < now - 30) throw new Error('token expired');
  if (payload.iat > now + 30) throw new Error('token from future');
  return {
    uid: payload.sub,
    email: payload.email || null,
    emailVerified: !!payload.email_verified,
    phone: payload.phone_number || null,
    provider: payload.firebase && payload.firebase.sign_in_provider,
  };
}

module.exports = { verifyIdToken, PROJECT_ID };
