/**
 * GET /api/logs/download-bitrix
 *
 * Downloads Bitrix-related logs from PostgreSQL as a plain-text file.
 * Filters rows where source LIKE '%bitrix%' OR event_type LIKE '%bitrix%'.
 * Returns the last 1 000 matching rows sorted by created_at DESC.
 *
 * Response: text/plain attachment named "logs-bitrix-YYYY-MM-DD.txt"
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
    const { rows } = await pool.query(
      `SELECT * FROM logs
       WHERE source ILIKE '%bitrix%' OR event_type ILIKE '%bitrix%'
       ORDER BY created_at DESC
       LIMIT 1000`
    );

    const lines = [];
    const dateLabel = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    lines.push('='.repeat(80));
    lines.push('BITRIX INTEGRATION LOGS');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('Filter: source ILIKE \'%bitrix%\' OR event_type ILIKE \'%bitrix%\'');
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
    res.setHeader('Content-Disposition', `attachment; filename="logs-bitrix-${dateLabel}.txt"`);
    return res.status(200).send(logText);
  } catch (err) {
    console.error('[logs/download-bitrix] Query failed:', err.message);
    return res.status(500).json({ error: 'Failed to download Bitrix logs', detail: err.message });
  }
}
