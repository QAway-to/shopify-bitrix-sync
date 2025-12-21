// Get all successful operations
import { successAdapter } from '../../../src/lib/adapters/success/index.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const operations = successAdapter.getAllOperations();
    
    return res.status(200).json({
      success: true,
      operations: operations,
      count: operations.length
    });
  } catch (error) {
    console.error('Get success operations error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve success operations',
      message: error.message
    });
  }
}

