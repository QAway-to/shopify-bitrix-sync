import { useState } from 'react';
import { sanitizeData } from '../../lib/utils/sanitize';

export default function DataPreview({ shopifyData, bitrixData, eventId, onSendEvent, isSending, eventType, operation, isGuestMode = false }) {
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

  // Sanitize data for guest mode
  const sanitizedShopifyData = isGuestMode ? sanitizeData(shopifyData, true) : shopifyData;
  const sanitizedBitrixData = isGuestMode ? sanitizeData(bitrixData, true) : bitrixData;

  return (
    <div className="card" style={{ marginTop: '20px', position: 'relative' }}>
      <header className="card-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>{previewTitle}</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {shopifyData && (
              <button
                onClick={() => !isGuestMode && setActiveTab('shopify')}
                disabled={isGuestMode}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'shopify' ? '#3b82f6' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: isGuestMode ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                  opacity: isGuestMode ? 0.5 : 1
                }}
              >
                Shopify Data
              </button>
            )}
            {bitrixData && (
              <button
                onClick={() => !isGuestMode && setActiveTab('bitrix')}
                disabled={isGuestMode}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'bitrix' ? '#3b82f6' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: isGuestMode ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                  opacity: isGuestMode ? 0.5 : 1
                }}
              >
                Bitrix Data
              </button>
            )}
            {operation && (
              <button
                onClick={() => !isGuestMode && setActiveTab('operation')}
                disabled={isGuestMode}
                style={{
                  padding: '6px 12px',
                  background: activeTab === 'operation' ? '#059669' : '#334155',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#f1f5f9',
                  cursor: isGuestMode ? 'not-allowed' : 'pointer',
                  fontSize: '0.9rem',
                  opacity: isGuestMode ? 0.5 : 1
                }}
              >
                Operation Details
              </button>
            )}
          </div>
        </div>
      </header>
      <div style={{ padding: '20px' }}>
        {activeTab === 'shopify' && sanitizedShopifyData && (
          <div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>Received Shopify Order Data</h3>
                <button
                  onClick={() => {
                    if (!isGuestMode) {
                      navigator.clipboard.writeText(JSON.stringify(sanitizedShopifyData, null, 2));
                    }
                  }}
                  disabled={isGuestMode}
                  style={{
                    padding: '4px 8px',
                    background: isGuestMode ? '#475569' : '#334155',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    color: '#f1f5f9',
                    cursor: isGuestMode ? 'not-allowed' : 'pointer',
                    fontSize: '0.85rem',
                    opacity: isGuestMode ? 0.5 : 1
                  }}
                >
                  Copy JSON
                </button>
              </div>
              {sanitizedShopifyData.received_at && (
                <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '8px' }}>
                  Received at: {new Date(sanitizedShopifyData.received_at).toLocaleString()}
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
              {JSON.stringify(sanitizedShopifyData, null, 2)}
            </pre>
          </div>
        )}
        {activeTab === 'bitrix' && sanitizedBitrixData && (
          <div>
            <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>
                {eventType === 'bitrix' ? 'Bitrix24 Deal Data' : 'Transformed Bitrix24 Deal Data'}
              </h3>
              <button
                onClick={() => {
                  if (!isGuestMode) {
                    navigator.clipboard.writeText(JSON.stringify(sanitizedBitrixData, null, 2));
                  }
                }}
                disabled={isGuestMode}
                style={{
                  padding: '4px 8px',
                  background: isGuestMode ? '#475569' : '#334155',
                  border: '1px solid #475569',
                  borderRadius: '4px',
                  color: '#f1f5f9',
                  cursor: isGuestMode ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem',
                  opacity: isGuestMode ? 0.5 : 1
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
              {JSON.stringify(sanitizedBitrixData, null, 2)}
            </pre>
          </div>
        )}
        {activeTab === 'operation' && operation && (
          <div>
            <div style={{ marginBottom: '12px' }}>
              <h3 style={{ color: '#f1f5f9', fontSize: '1rem', margin: 0 }}>Operation Details</h3>
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
              {JSON.stringify(isGuestMode ? sanitizeData(operation, true) : operation, null, 2)}
            </pre>
          </div>
        )}
        {onSendEvent && (
          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={onSendEvent}
              disabled={isSending || isGuestMode}
              style={{
                padding: '10px 20px',
                background: (isSending || isGuestMode) ? '#475569' : '#059669',
                border: 'none',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '1rem',
                fontWeight: '500',
                cursor: (isSending || isGuestMode) ? 'not-allowed' : 'pointer',
                opacity: (isSending || isGuestMode) ? 0.5 : 1
              }}
            >
              {isSending ? 'Sending...' : 'Send to Bitrix'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
