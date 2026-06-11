import crypto from 'crypto';

const COOKIE_NAME = 'session';
const TTL_MS = 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET env var is not configured');
  return s;
}

function sign(expiresMs) {
  return crypto.createHmac('sha256', getSecret()).update(String(expiresMs)).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      let val = v.join('=');
      try { val = decodeURIComponent(val); } catch { /* keep raw */ }
      return [k.trim(), val];
    })
  );
}

export function mintToken(ttlMs = TTL_MS) {
  const expires = Date.now() + ttlMs;
  return `auth:${expires}.${sign(expires)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  if (!token.startsWith('auth:')) return false;
  const rest = token.slice(5);
  const dotIdx = rest.indexOf('.');
  if (dotIdx === -1) return false;
  const expStr = rest.slice(0, dotIdx);
  const sig = rest.slice(dotIdx + 1);
  const expires = parseInt(expStr, 10);
  if (!Number.isFinite(expires) || Date.now() >= expires) return false;
  const expected = sign(expires);
  // Hash both to fixed 32-byte length before comparing — avoids length side-channel
  const aBuf = crypto.createHash('sha256').update(sig).digest();
  const bBuf = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function buildCookieValue(token, ttlMs) {
  const secure = IS_PROD ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secure}`;
}

export function setSessionCookie(res, ttlMs = TTL_MS) {
  res.setHeader('Set-Cookie', buildCookieValue(mintToken(ttlMs), ttlMs));
}

export function clearSessionCookie(res) {
  const secure = IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

export function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

// Returns true if authenticated. If not, sends 401 and returns false.
// Callers MUST: if (!requireAuth(req, res)) return;
export function requireAuth(req, res) {
  if (isAuthenticated(req)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
