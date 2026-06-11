import { useState, useEffect } from 'react';

const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const selectStyle = {
  background: '#1e293b',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '6px',
  color: '#f1f5f9',
  padding: '4px 8px',
  fontSize: '13px',
  cursor: 'pointer',
};

function Badge({ ok, okLabel = 'OK', failLabel }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 600,
      color: ok ? '#10b981' : '#ef4444',
      background: ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
      whiteSpace: 'nowrap',
    }}>
      {ok ? okLabel : failLabel}
    </span>
  );
}

function PositionDiffRow({ diff }) {
  const colors = {
    qty_mismatch:       '#f59e0b',
    missing_in_shopify: '#ef4444',
    missing_in_bitrix:  '#3b82f6',
  };
  const labels = {
    qty_mismatch:       'Qty mismatch',
    missing_in_shopify: 'Missing in Shopify',
    missing_in_bitrix:  'Missing in Bitrix',
  };
  const color = colors[diff.type] || '#94a3b8';
  return (
    <div style={{ fontSize: '11px', color, marginBottom: '2px' }}>
      <span style={{ fontWeight: 600 }}>{diff.sku}</span>
      {' — '}{labels[diff.type] || diff.type}
      {diff.type === 'qty_mismatch' && ` (Bitrix: ${diff.bitrixQty}, Shopify: ${diff.shopifyQty})`}
    </div>
  );
}

function DealRow({ deal }) {
  const [expanded, setExpanded] = useState(false);
  const hasDiffs = deal.positions_diff?.length > 0;

  return (
    <>
      <tr
        onClick={() => hasDiffs && setExpanded(e => !e)}
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          cursor: hasDiffs ? 'pointer' : 'default',
          background: deal.has_discrepancy ? 'rgba(239,68,68,0.03)' : 'transparent',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
        onMouseLeave={e => e.currentTarget.style.background = deal.has_discrepancy ? 'rgba(239,68,68,0.03)' : 'transparent'}
      >
        <td style={{ padding: '8px 10px', color: '#f1f5f9', fontWeight: 500 }}>{deal.deal_id}</td>
        <td style={{ padding: '8px 10px', color: '#94a3b8', fontSize: '12px' }}>{deal.order_id || '—'}</td>
        <td style={{ padding: '8px 10px' }}>
          <Badge ok={deal.stage_match} okLabel='✓' failLabel={`${deal.bitrix_stage} → ${deal.expected_stage}`} />
        </td>
        <td style={{ padding: '8px 10px' }}>
          {deal.total_bitrix != null && deal.total_shopify != null ? (
            <Badge
              ok={deal.total_match}
              okLabel='✓'
              failLabel={`${deal.total_bitrix} / ${deal.total_shopify}`}
            />
          ) : <span style={{ color: '#475569', fontSize: '12px' }}>—</span>}
        </td>
        <td style={{ padding: '8px 10px', color: hasDiffs ? '#f59e0b' : '#10b981', fontSize: '12px', textAlign: 'center' }}>
          {deal.positions_matched}/{deal.positions_total}
          {hasDiffs && <span style={{ marginLeft: '4px' }}>{expanded ? '▲' : '▼'}</span>}
        </td>
        <td style={{ padding: '8px 10px' }}>
          {deal.has_discrepancy
            ? <span style={{ color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>Mismatch</span>
            : <span style={{ color: '#10b981', fontSize: '12px' }}>OK</span>}
        </td>
      </tr>
      {expanded && hasDiffs && (
        <tr style={{ background: 'rgba(0,0,0,0.2)' }}>
          <td colSpan={6} style={{ padding: '8px 16px 8px 32px' }}>
            {deal.positions_diff.map((d) => <PositionDiffRow key={d.sku} diff={d} />)}
          </td>
        </tr>
      )}
    </>
  );
}

export default function DealSnapshotMonitor() {
  const [availableDates, setAvailableDates]     = useState([]);
  const [selectedYearMonth, setSelectedYearMonth] = useState(null);
  const [selectedDate, setSelectedDate]          = useState(null);
  const [data, setData]                          = useState(null);
  const [loading, setLoading]                    = useState(true);
  const [error, setError]                        = useState(null);
  const [lastRun, setLastRun]                    = useState(null);
  const [triggering, setTriggering]              = useState(false);

  const dateTree = availableDates.reduce((tree, d) => {
    const [y, m] = d.split('-');
    const key = `${y}-${m}`;
    if (!tree[key]) tree[key] = { year: y, month: m, dates: [] };
    tree[key].dates.push(d);
    return tree;
  }, {});
  const yearMonthKeys = Object.keys(dateTree);

  useEffect(() => {
    Promise.all([
      fetch('/api/monitor/snapshot?dates=1').then(r => r.json()),
      fetch('/api/monitor/snapshot?status=1').then(r => r.json()),
    ]).then(([datesJson, statusJson]) => {
      const dates = datesJson.dates || [];
      setAvailableDates(dates);
      setLastRun(statusJson.run || null);
      if (dates.length > 0) {
        const [y, m] = dates[0].split('-');
        setSelectedYearMonth(`${y}-${m}`);
        setSelectedDate(dates[0]);
      } else {
        setLoading(false);
      }
    }).catch(() => setLoading(false));
  }, []);

  const handleYearMonthChange = (key) => {
    setSelectedYearMonth(key);
    const datesInMonth = dateTree[key]?.dates || [];
    if (datesInMonth.length > 0) setSelectedDate(datesInMonth[0]);
  };

  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    setError(null);
    fetch(`/api/monitor/snapshot?date=${selectedDate}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) throw new Error(json.error);
        setData(json);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  const handleTrigger = async () => {
    setTriggering(true);
    setError(null);
    try {
      const res = await fetch('/api/monitor/snapshot', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Failed to start (${res.status})`);
        setTriggering(false);
        return;
      }
      if (body.skipped) {
        setError('Snapshot already completed for today');
        setTriggering(false);
        return;
      }
      setTimeout(() => {
        fetch('/api/monitor/snapshot?status=1').then(r => r.json()).then(j => setLastRun(j.run || null));
        setTriggering(false);
      }, 2000);
    } catch {
      setError('Network error');
      setTriggering(false);
    }
  };

  const datesInMonth = selectedYearMonth ? (dateTree[selectedYearMonth]?.dates || []) : [];

  return (
    <div style={{ marginBottom: '32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>
          Deal Comparison
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {lastRun && (
            <span style={{ fontSize: '11px', color: lastRun.status === 'success' ? '#10b981' : lastRun.status === 'failed' ? '#ef4444' : '#94a3b8' }}>
              {lastRun.date} · {lastRun.status}
              {lastRun.deals_checked != null ? ` · ${lastRun.deals_checked} deals` : ''}
            </span>
          )}
          <button
            onClick={handleTrigger}
            disabled={triggering}
            style={{
              background: '#1e293b',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
              color: '#f1f5f9',
              padding: '4px 12px',
              fontSize: '12px',
              cursor: triggering ? 'not-allowed' : 'pointer',
            }}
          >
            {triggering ? '...' : 'Run'}
          </button>
        </div>
      </div>

      {/* Date picker */}
      {availableDates.length > 0 && (
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>Period:</span>
          <select value={selectedYearMonth || ''} onChange={e => handleYearMonthChange(e.target.value)} style={selectStyle}>
            {yearMonthKeys.map(key => {
              const { year, month } = dateTree[key];
              return <option key={key} value={key}>{monthNames[parseInt(month,10)-1]} {year}</option>;
            })}
          </select>
          <select value={selectedDate || ''} onChange={e => setSelectedDate(e.target.value)} style={selectStyle}>
            {datesInMonth.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}

      {loading && <p style={{ color: '#94a3b8', fontSize: '13px' }}>Loading...</p>}
      {error && <p style={{ color: '#ef4444', fontSize: '13px' }}>Error: {error}</p>}

      {!loading && !error && data && (
        <>
          {/* Summary bar */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
            {[
              { label: 'Total Deals',   value: data.summary.total,            color: '#94a3b8' },
              { label: 'Discrepancies', value: data.summary.withDiscrepancy,  color: '#ef4444' },
              { label: 'Stage',         value: data.summary.stageMismatch,    color: '#f59e0b' },
              { label: 'Amount',        value: data.summary.totalMismatch,    color: '#f59e0b' },
              { label: 'Positions',     value: data.summary.positionMismatch, color: '#f59e0b' },
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

          {data.deals.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>No data for {data.date}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
                    {['Deal','Order','Stage','Amount','Positions','Result'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.deals.map(deal => <DealRow key={deal.deal_id} deal={deal} />)}
                </tbody>
              </table>
              <p style={{ fontSize: '11px', color: '#475569', marginTop: '8px' }}>
                Click a row with position discrepancies to expand details.
              </p>
            </div>
          )}
        </>
      )}

      {!loading && !error && availableDates.length === 0 && (
        <p style={{ color: '#94a3b8', fontSize: '13px' }}>
          No data yet. Click Run to trigger the first snapshot.
        </p>
      )}
    </div>
  );
}
