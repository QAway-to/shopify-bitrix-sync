// Get all Shopify events
import { shopifyAdapter } from '../../src/lib/adapters/shopify/index.js';
import { sanitizeData } from '../../src/lib/utils/sanitize.js';
import { requireAuth } from '../../src/lib/auth/session.js';

// ✅ Demo mode: mask sensitive data in API responses
const isDemoMode = process.env.DEMO_MODE === 'true';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!requireAuth(req, res)) return;

  try {
    // ✅ Return ALL events without deduplication so UI can show full history
    const events = shopifyAdapter.getAllEvents(true); // includeAll = true

    // ✅ Apply demo mode masking at API level (hides data from DevTools too)
    const sanitizedEvents = sanitizeData(events, isDemoMode);

    return res.status(200).json({
      success: true,
      events: sanitizedEvents,
      count: events.length,
      demoMode: isDemoMode
    });
  } catch (error) {
    console.error('Get events error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve events',
      message: error.message
    });
  }
}

