import { clearSessionCookie } from '../../../src/lib/auth/session.js';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  clearSessionCookie(res);
  return res.status(200).json({ success: true });
}
