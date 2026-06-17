import { requireAuth } from '../../../src/lib/auth/session.js';

// API endpoint to get sync progress
const isServer = typeof window === 'undefined';
let readFileSync, existsSync, join;

if (isServer) {
  const fs = eval('require')('fs');
  const path = eval('require')('path');
  readFileSync = fs.readFileSync;
  existsSync = fs.existsSync;
  join = path.join;
}

const PROGRESS_DIR = join(process.cwd(), '.data', 'progress');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!requireAuth(req, res)) return;

  const requestId = req.query.requestId;

  if (!requestId) {
    return res.status(400).json({
      success: false,
      error: 'requestId is required'
    });
  }

  if (!isServer) {
    return res.status(500).json({
      success: false,
      error: 'Server-side only'
    });
  }

  try {
    const PROGRESS_DIR = join(process.cwd(), '.data', 'progress');
    const progressFile = join(PROGRESS_DIR, `${requestId}.json`);

    if (!existsSync(progressFile)) {
      return res.status(404).json({
        success: false,
        error: 'Progress not found',
        message: 'Sync process not found or not started yet'
      });
    }

    const progress = JSON.parse(readFileSync(progressFile, 'utf-8'));

    return res.status(200).json({
      success: true,
      progress
    });
  } catch (error) {
    console.error('[PROGRESS] Error reading progress:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to read progress',
      message: error.message
    });
  }
}

