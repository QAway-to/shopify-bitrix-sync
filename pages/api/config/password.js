// API endpoint to get webhook password from environment variable
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Get password from environment variable (default to '1spotify2' for backward compatibility)
    const password = process.env.WEBHOOK_PASSWORD || '1spotify2';
    
    return res.status(200).json({
      success: true,
      password: password
    });
  } catch (error) {
    console.error('Get password error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve password',
      message: error.message
    });
  }
}

