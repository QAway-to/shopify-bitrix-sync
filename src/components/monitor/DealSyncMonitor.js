import { useState, useEffect } from 'react';

const STATUS_CONFIG = {
  ok:         { label: '✅ OK',        color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  errors:     { label: '❌ Ошибки',    color: '#ef4444', bg: 'rgba(239,68,68,0.1)'  },
  orphans:    { label: '⚠️ Orphans',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  no_changes: { label: '— Без изм.',   color: '#6b7280', bg: 'rgba(107,114,128,0.1)'},
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.no_changes;
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
        { label: 'Всего сделок', value: summary.total,       color: '#94a3b8' },
        { label: 'OK',           value: summary.ok,           color: '#10b981' },
        { label: 'Ошибки',       value: summary.withErrors,   color: '#ef4444' },
        { label: 'Orphans',      value: summary.withOrphans,  color: '#f59e0b' },
        { label: 'Без изменений',value: summary.noChanges,    color: '#6b7280' },
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

export default function DealSyncMonitor() {
  const [availableDates, setAvailableDates] = useState([]);
  const [selectedDate, setSelectedDate]     = useState(null);
  const [data, setData]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState(null);

  // Load available dates once
  useEffect(() => {
    fetch('/api/monitor/summary?dates=1')
      .then(r => r.json())
      .then(json => {
        const dates = json.dates || [];
        setAvailableDates(dates);
        if (dates.length > 0) setSelectedDate(dates[0]); // most recent
        else setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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

  // Group available dates by year → month
  const dateTree = availableDates.reduce((tree, d) => {
    const [y, m] = d.split('-');
    const key = `${y}-${m}`;
    if (!tree[key]) tree[key] = { year: y, month: m, dates: [] };
    tree[key].dates.push(d);
    return tree;
  }, {});

  const monthNames = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];

  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#f1f5f9', margin: 0 }}>
          Монитор синхронизации
        </h2>
        <a
          href={logsApiUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '12px', color: '#3b82f6', textDecoration: 'none' }}
        >
          API логов →
        </a>
      </div>

      {/* Date picker — only available dates */}
      {availableDates.length > 0 && (
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>Дата:</span>
          <select
            value={selectedDate || ''}
            onChange={e => setSelectedDate(e.target.value)}
            style={{
              background: '#1e293b',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '6px',
              color: '#f1f5f9',
              padding: '4px 8px',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {Object.values(dateTree).map(({ year, month, dates }) => (
              <optgroup key={`${year}-${month}`} label={`${monthNames[parseInt(month,10)-1]} ${year}`}>
                {dates.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {loading && (
        <p style={{ color: '#94a3b8', fontSize: '13px' }}>Загрузка...</p>
      )}

      {error && (
        <p style={{ color: '#ef4444', fontSize: '13px' }}>Ошибка: {error}</p>
      )}

      {!loading && !error && data && (
        <>
          <SummaryBar summary={data.summary} />

          {data.deals.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: '13px' }}>Нет данных за {data.date}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }}>
                    {['Сделка','Заказ','Синков','Добавл.','Изм. кол','Orphans','Ошибки','Статус'].map(h => (
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
          Данных пока нет. Монитор заполнится после первой агрегации в 10:00 МСК.
        </p>
      )}
    </div>
  );
}
