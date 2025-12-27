// API endpoint to get webhook password from environment variable
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const password = process.env.WEBHOOK_PASSWORD;

    if (typeof password !== 'string' || password.trim() === '') {
      return res.status(200).json({
        success: false,
        error: 'WEBHOOK_PASSWORD is not configured'
      });
    }

    return res.status(200).json({
      success: true,
      password: password.trim()
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
