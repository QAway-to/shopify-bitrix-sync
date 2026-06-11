import crypto from 'crypto';
import { setSessionCookie } from '../../../src/lib/auth/session.js';

// In-memory rate limiter: max 5 attempts per IP per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_ATTEMPTS) return true;
  entry.count += 1;
  return false;
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const expected = process.env.WEBHOOK_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'Auth not configured' });

  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'password required' });
  }

  // Hash both sides to fixed 32-byte length — eliminates length side-channel
  const hashA = crypto.createHash('sha256').update(password.trim()).digest();
  const hashB = crypto.createHash('sha256').update(expected.trim()).digest();
  if (!crypto.timingSafeEqual(hashA, hashB)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  setSessionCookie(res);
  return res.status(200).json({ success: true });
}
