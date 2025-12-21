import { useState } from 'react';

export default function DataPreview({ shopifyData, bitrixData, eventId, onSendEvent, isSending, eventType, operation }) {
  const [activeTab, setActiveTab] = useState(
    eventType === 'success' ? 'operation' : (shopifyData ? 'shopify' : 'bitrix')
  ); // 'shopify', 'bitrix', or 'operation'

  if (!shopifyData && !bitrixData && !operation) {
    return null;
  }

  const previewTitle = eventType === 'bitrix' 
    ? `Data Preview ${eventId ? `(Deal #${eventId})` : ''}`
    : eventType === 'success'
      ? `✓ Success Operation ${eventId ? `(Deal #${eventId})` : ''}`
      : `Data Preview ${eventId ? `(Order #${eventId})` : ''}`;

  return (
    <div className="card" style={{ marginTop: '20px' }}>
      <header className="card-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{previewTitle}</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {shopifyData && (
              <button
                onClick={() => setActiveTab('shopify')}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'shopify' ? '#3b82f6' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Shopify Data
              </button>
            )}
            {bitrixData && (
              <button
                onClick={() => setActiveTab('bitrix')}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'bitrix' ? '#3b82f6' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Bitrix Data
              </button>
            )}
            {operation && (
              <button
                onClick={() => setActiveTab('operation')}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'operation' ? '#059669' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Operation Details
              </button>
            )}
          </div>
        </div>
      </header>
      <div style={{ padding: '20px' }}>
        {activeTab === 'shopify' && shopifyData && (
          <div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>Received Shopify Order Data</h3>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(shopifyData, null, 2));
                  }}
                  style={{
                    padding: '4px 8px',
                    background: '#334155',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    color: '#f1f5f9',
                    cursor: 'pointer',
                    fontSize: '0.85rem'
                  }}
                >
                  Copy JSON
                </button>
              </div>
              {shopifyData.received_at && (
                <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '8px' }}>
                  Received at: {new Date(shopifyData.received_at).toLocaleString()}
                </div>
              )}
            </div>
            <pre style={{
              padding: '16px',
              background: '#1e293b',
              borderRadius: '8px',
              overflowX: 'auto',
              fontSize: '0.85rem',
              color: '#f1f5f9',
              border: '1px solid #334155',
              maxHeight: '600px',
              overflowY: 'auto'
            }}>
              {JSON.stringify(shopifyData, null, 2)}
            </pre>
          </div>
        )}
        {activeTab === 'bitrix' && bitrixData && (
          <div>
            <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>
                {eventType === 'bitrix' ? 'Bitrix24 Deal Data' : 'Transformed Bitrix24 Deal Data'}
              </h3>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(bitrixData, null, 2));
                }}
                style={{
                  padding: '4px 8px',
                  background: '#334155',
                  border: '1px solid #475569',
                  borderRadius: '4px',
                  color: '#f1f5f9',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
              >
                Copy JSON
              </button>
            </div>
            <pre style={{
              padding: '16px',
              background: '#1e293b',
              borderRadius: '8px',
              overflowX: 'auto',
              fontSize: '0.85rem',
              color: '#f1f5f9',
              border: '1px solid #334155',
              maxHeight: '600px',
              overflowY: 'auto'
            }}>
              {JSON.stringify(bitrixData, null, 2)}
            </pre>
          </div>
        )}
        {activeTab === 'operation' && operation && (
          <div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>Success Operation Details</h3>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(operation, null, 2));
                  }}
                  style={{
                    padding: '4px 8px',
                    background: '#334155',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    color: '#f1f5f9',
                    cursor: 'pointer',
                    fontSize: '0.85rem'
                  }}
                >
                  Copy JSON
                </button>
              </div>
              <div style={{ 
                padding: '12px', 
                background: operation.verified ? 'rgba(5, 150, 105, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                borderRadius: '6px',
                marginBottom: '12px',
                border: `1px solid ${operation.verified ? 'rgba(5, 150, 105, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`
              }}>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ color: '#94a3b8' }}>Operation Type:</strong>
                    <span style={{ color: '#f1f5f9', marginLeft: '8px' }}>
                      {operation.operationType === 'CREATE' ? '✓ Создана' : operation.operationType === 'UPDATE' ? '✓ Обновлена' : operation.operationType}
                    </span>
                  </div>
                  <div>
                    <strong style={{ color: '#94a3b8' }}>Verified:</strong>
                    <span style={{ 
                      color: operation.verified ? '#10b981' : '#f59e0b', 
                      marginLeft: '8px',
                      fontWeight: 600
                    }}>
                      {operation.verified ? '✓ Да' : '⚠ Нет'}
                    </span>
                  </div>
                  {operation.attempt && (
                    <div>
                      <strong style={{ color: '#94a3b8' }}>Attempt:</strong>
                      <span style={{ color: '#f1f5f9', marginLeft: '8px' }}>{operation.attempt}</span>
                    </div>
                  )}
                  {operation.timestamp && (
                    <div>
                      <strong style={{ color: '#94a3b8' }}>Timestamp:</strong>
                      <span style={{ color: '#f1f5f9', marginLeft: '8px' }}>
                        {new Date(operation.timestamp).toLocaleString('ru-RU')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <pre style={{
              padding: '16px',
              background: '#1e293b',
              borderRadius: '8px',
              overflowX: 'auto',
              fontSize: '0.85rem',
              color: '#f1f5f9',
              border: '1px solid #334155',
              maxHeight: '600px',
              overflowY: 'auto'
            }}>
              {JSON.stringify(operation, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
