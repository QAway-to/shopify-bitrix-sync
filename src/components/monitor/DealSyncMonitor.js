import { useState, useEffect } from 'react';

const STATUS_CONFIG = {
  critical:   { label: 'Critical',  color: '#ef4444', bg: 'rgba(239,68,68,0.1)'   },
  warning:    { label: 'Warning',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  ok:         { label: 'OK',        color: '#10b981', bg: 'rgba(16,185,129,0.1)'  },
  quiet:      { label: 'Quiet',     color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
  // legacy values from old records
  errors:     { label: 'Warning',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  orphans:    { label: 'Warning',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  no_changes: { label: 'Quiet',     color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.quiet;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 600,
      color: cfg.color,
      background: cfg.bg,
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

function SummaryBar({ summary }) {
  if (!summary) return null;
  return (
    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '16px' }}>
      {[
        { label: 'Total',    value: summary.total,    color: '#94a3b8' },
        { label: 'OK',       value: summary.ok,       color: '#10b981' },
        { label: 'Critical', value: summary.critical, color: '#ef4444' },
        { label: 'Warning',  value: summary.warning,  color: '#f59e0b' },
        { label: 'Quiet',    value: summary.quiet,    color: '#6b7280' },
      ].map(({ label, value, color }) => (
        <div key={label} style={{
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.04)',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.08)',
          minWidth: '90px',
        }}>
          <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value ?? '—'}</div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function DealSyncMonitor() {
  const [availableDates, setAvailableDates] = useState([]);
  const [selectedYearMonth, setSelectedYearMonth] = useState(null);
  const [selectedDate, setSelectedDate]     = useState(null);
  const [data, setData]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);

  // Group dates by year-month key
  const dateTree = availableDates.reduce((tree, d) => {
    const [y, m] = d.split('-');
    const key = `${y}-${m}`;
    if (!tree[key]) tree[key] = { year: y, month: m, dates: [] };
    tree[key].dates.push(d);
    return tree;
  }, {});

  const yearMonthKeys = Object.keys(dateTree); // sorted desc by API

  // Load available dates once
  useEffect(() => {
    fetch('/api/monitor/summary?dates=1')
      .then(r => r.json())
      .then(json => {
        const dates = json.dates || [];
        setAvailableDates(dates);
        if (dates.length > 0) {
          const [y, m] = dates[0].split('-');
          const firstKey = `${y}-${m}`;
          setSelectedYearMonth(firstKey);
          setSelectedDate(dates[0]);
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, []);

  // When year-month changes, auto-select most recent date in that month
  const handleYearMonthChange = (key) => {
    setSelectedYearMonth(key);
    const datesInMonth = dateTree[key]?.dates || [];
    if (datesInMonth.length > 0) setSelectedDate(datesInMonth[0]);
  };

  // Load summary when date changes
  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    setError(null);
    fetch(`/api/monitor/summary?date=${selectedDate}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error);
        setData(json);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  const logsApiUrl = 'https://render-agent-a-mvp.onrender.com/api/logs/query';

  const selectStyle = {
    background: '#1e293b',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '6px',
    color: '#f1f5f9',
    padding: '4px 8px',
    fontSize: '13px',
    cursor: 'pointer',
  };

  const datesInSelectedMonth = selectedYearMonth ? (dateTree[selectedYearMonth]?.dates || []) : [];

  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>
          Sync Monitor
        </h2>
        <a
          href={logsApiUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '12px', color: '#3b82f6', textDecoration: 'none' }}
        >
          Logs API →
        </a>
      </div>

      {/* Two-level date picker */}
      {availableDates.length > 0 && (
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>Period:</span>
          <select
            value={selectedYearMonth || ''}
            onChange={e => handleYearMonthChange(e.target.value)}
            style={selectStyle}
          >
            {yearMonthKeys.map(key => {
              const { year, month } = dateTree[key];
              return (
                <option key={key} value={key}>
                  {monthNames[parseInt(month, 10) - 1]} {year}
                </option>
              );
            })}
          </select>
          <select
            value={selectedDate || ''}
            onChange={e => setSelectedDate(e.target.value)}
            style={selectStyle}
          >
            {datesInSelectedMonth.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      )}

      {loading && (
        <p style={{ color: '#94a3b8', fontSize: '13px' }}>Loading...</p>
      )}

      {error && (
        <p style={{ color: '#ef4444', fontSize: '13px' }}>Error: {error}</p>
      )}

      {!loading && !error && data && (
        <>
          <SummaryBar summary={data.summary} />

          {data.deals.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>No data for {data.date}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
                    {['Deal','Order','Syncs','Added','Qty Changes','Orphans','Errors','Status'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.deals.map(deal => (
                    <tr
                      key={deal.deal_id}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '8px 10px', color: '#f1f5f9', fontWeight: 500 }}>{deal.deal_id}</td>
                      <td style={{ padding: '8px 10px', color: '#94a3b8' }}>{deal.order_id || '—'}</td>
                      <td style={{ padding: '8px 10px', color: '#94a3b8', textAlign: 'center' }}>{deal.syncs_count}</td>
                      <td style={{ padding: '8px 10px', color: deal.added > 0 ? '#10b981' : '#94a3b8', textAlign: 'center' }}>{deal.added}</td>
                      <td style={{ padding: '8px 10px', color: (deal.incremented + deal.decremented) > 0 ? '#3b82f6' : '#94a3b8', textAlign: 'center' }}>
                        {deal.incremented + deal.decremented > 0
                          ? `+${deal.incremented} / -${deal.decremented}`
                          : '0'}
                      </td>
                      <td style={{ padding: '8px 10px', color: deal.orphans_count > 0 ? '#f59e0b' : '#94a3b8', textAlign: 'center' }}>{deal.orphans_count}</td>
                      <td style={{ padding: '8px 10px', color: deal.errors_count > 0 ? '#ef4444' : '#94a3b8', textAlign: 'center' }}>{deal.errors_count}</td>
                      <td style={{ padding: '8px 10px' }}><StatusBadge status={deal.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!loading && !error && availableDates.length === 0 && (
        <p style={{ color: '#94a3b8', fontSize: '13px' }}>
          No data yet. Monitor populates after first aggregation at 10:00 MSK.
        </p>
      )}
    </div>
  );
}
