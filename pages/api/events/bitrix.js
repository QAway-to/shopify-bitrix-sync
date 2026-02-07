// Get all Bitrix events
import { bitrixAdapter } from '../../../src/lib/adapters/bitrix/index.js';
import { sanitizeData } from '../../../src/lib/utils/sanitize.js';

// ✅ Demo mode: mask sensitive data in API responses
const isDemoMode = process.env.DEMO_MODE === 'true';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const events = bitrixAdapter.getAllEvents();

    // ✅ Apply demo mode masking at API level
    const sanitizedEvents = sanitizeData(events, isDemoMode);

    return res.status(200).json({
      success: true,
      events: sanitizedEvents,
      count: events.length,
      demoMode: isDemoMode
    });
  } catch (error) {
    console.error('Get Bitrix events error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve Bitrix events',
      message: error.message
    });
  }
}







