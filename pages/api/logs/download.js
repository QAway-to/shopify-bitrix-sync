/**
 * GET /api/logs/download
 *
 * Downloads all logs from PostgreSQL as a plain-text file.
 * Returns the last 1 000 rows sorted by created_at DESC.
 *
 * Optional query parameter:
 *   source — filter by exact source value (e.g. "webhook/shopify")
 *
 * Response: text/plain attachment named "logs-YYYY-MM-DD.txt"
 */

import { pool } from '../../../src/lib/logging/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!pool) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    const { source } = req.query;

    const conditions = [];
    const params = [];

    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM logs ${where} ORDER BY created_at DESC LIMIT 1000`,
      params
    );

    const lines = [];
    const dateLabel = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    lines.push('='.repeat(80));
    lines.push('INTEGRATION LOGS');
    lines.push(`Generated: ${new Date().toISOString()}`);
    if (source) {
      lines.push(`Filter: source = ${source}`);
    }
    lines.push(`Rows returned: ${rows.length}`);
    lines.push('='.repeat(80));
    lines.push('');

    for (const row of rows) {
      const ts = row.created_at ? new Date(row.created_at).toISOString() : 'N/A';
      const level = (row.level ?? 'info').toUpperCase();
      const message = row.message ?? '';

      // Build the primary log line: [timestamp] [LEVEL] message
      let line = `[${ts}] [${level}]`;
      if (row.source) line += ` [${row.source}]`;
      if (row.event_type) line += ` <${row.event_type}>`;
      if (row.request_id) line += ` (${row.request_id})`;
      line += ` ${message}`;
      lines.push(line);

      // Append structured metadata on the next line if present
      if (row.metadata) {
        const meta = typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata);
        lines.push(`  metadata: ${meta}`);
      }

      // Extra fields
      if (row.entity_type || row.entity_id) {
        lines.push(`  entity: ${row.entity_type ?? ''}/${row.entity_id ?? ''}`);
      }
      if (row.duration_ms != null) {
        lines.push(`  duration: ${row.duration_ms}ms`);
      }

      lines.push('');
    }

    lines.push('='.repeat(80));
    lines.push(`End of log file — ${new Date().toISOString()}`);
    lines.push('='.repeat(80));

    const logText = lines.join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="logs-${dateLabel}.txt"`);
    return res.status(200).send(logText);
  } catch (err) {
    console.error('[logs/download] Query failed:', err.message);
    return res.status(500).json({ error: 'Failed to download logs', detail: err.message });
  }
}
