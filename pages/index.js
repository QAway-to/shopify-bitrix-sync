import Head from 'next/head';
import { useState, useEffect } from 'react';
import WebhookInfo from '../src/components/shopify/WebhookInfo';
import EventsList from '../src/components/shopify/EventsList';
import BitrixEventsList from '../src/components/bitrix/EventsList';
import SuccessOperationsList from '../src/components/success/SuccessOperationsList';
import DataPreview from '../src/components/shopify/DataPreview';
// Removed shopifyAdapter import - now using API endpoint for transformation

export default function ShopifyPage() {
  const [events, setEvents] = useState([]);
  const [selectedEvents, setSelectedEvents] = useState([]);
  const [bitrixEvents, setBitrixEvents] = useState([]);
  const [selectedBitrixEvents, setSelectedBitrixEvents] = useState([]);
  const [successOperations, setSuccessOperations] = useState([]);
  const [selectedSuccessOperations, setSelectedSuccessOperations] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBitrixLoading, setIsBitrixLoading] = useState(false);
  const [isSuccessLoading, setIsSuccessLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [isSendingToShopify, setIsSendingToShopify] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [sendToShopifyResult, setSendToShopifyResult] = useState(null);
  // Bitrix webhook URL from environment variable (via API)
  const [bitrixWebhookUrl, setBitrixWebhookUrl] = useState(null);
  const [isLoadingWebhookUrl, setIsLoadingWebhookUrl] = useState(true);
  const [previewEvent, setPreviewEvent] = useState(null); // Event to preview (Shopify)
  const [previewData, setPreviewData] = useState(null); // { shopifyData, bitrixData } for preview (Shopify)
  const [bitrixPreviewEvent, setBitrixPreviewEvent] = useState(null); // Event to preview (Bitrix)
  const [bitrixPreviewData, setBitrixPreviewData] = useState(null); // { shopifyData, bitrixData } for preview (Bitrix)
  const [successPreviewOperation, setSuccessPreviewOperation] = useState(null); // Operation to preview (Success)
  const [isInitialLoad, setIsInitialLoad] = useState(true); // Track initial load
  // ✅ Track if this is initial fetch to show loading state
  const [isInitialFetch, setIsInitialFetch] = useState(true);
  // Inventory sync state
  const [syncStatus, setSyncStatus] = useState({ isRunning: false, lastRun: null });
  const [selectedSectionId, setSelectedSectionId] = useState('all');
  const [inventorySyncResult, setInventorySyncResult] = useState(null);

  // Section options for dropdown
  const SECTION_OPTIONS = [
    { value: 'all', label: 'Все категории' },
    { value: '36', label: 'A-F (36)' },
    { value: '38', label: 'G-M (38)' },
    { value: '40', label: 'N-S (40)' },
    { value: '42', label: 'T-Z (42)' }
  ];

  // Fetch sync status periodically
  const fetchSyncStatus = async () => {
    try {
      const response = await fetch('/api/cron/sync-inventory');
      const data = await response.json();
      setSyncStatus({ isRunning: data.isRunning, lastRun: data.lastRun });
    } catch (err) {
      console.error('Error fetching sync status:', err);
    }
  };

  // Handle inventory sync with section selection
  const handleSyncInventory = async () => {
    setInventorySyncResult(null);
    const sectionIds = selectedSectionId === 'all' ? [36, 38, 40, 42] : [parseInt(selectedSectionId)];
    try {
      const response = await fetch('/api/cron/sync-inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionIds })
      });
      const data = await response.json();
      if (response.ok) {
        setInventorySyncResult({
          success: true,
          message: `Синхронизация запущена для ${selectedSectionId === 'all' ? 'всех категорий' : SECTION_OPTIONS.find(o => o.value === selectedSectionId)?.label}. Проверьте логи.`,
          requestId: data.requestId
        });
        setSyncStatus({ isRunning: true, lastRun: syncStatus.lastRun });
      } else {
        setInventorySyncResult({
          success: false,
          message: data.error || 'Ошибка запуска синхронизации'
        });
      }
    } catch (err) {
      setInventorySyncResult({
        success: false,
        message: err.message || 'Network error'
      });
    }
  };

  const fetchBitrixWebhookUrl = async () => {
    setIsLoadingWebhookUrl(true);
    try {
      const response = await fetch('/api/config/bitrix-webhook-url');
      const data = await response.json();
      if (data.success && data.webhookUrl) {
        setBitrixWebhookUrl(data.webhookUrl);
        console.log(`[UI] Bitrix webhook URL loaded from ${data.source}: ${data.webhookUrl}`);
      } else {
        console.error('Failed to fetch Bitrix webhook URL:', data.error);
      }
    } catch (err) {
      console.error('Fetch Bitrix webhook URL error:', err);
    } finally {
      setIsLoadingWebhookUrl(false);
    }
  };

  const fetchEvents = async () => {
    // ✅ Don't set loading state - we'll show inline loader for new rows only
    setError(null);

    try {
      const response = await fetch('/api/events');
      const data = await response.json();

      if (data.success) {
        const fetchedEvents = data.events || [];

        // ✅ Smart merge: only add new events, preserve existing ones
        setEvents(prevEvents => {
          // Create a Set of existing event IDs for fast lookup
          const existingIds = new Set(prevEvents.map(e => e.id || e.eventId));

          // Filter out events that already exist
          const newEvents = fetchedEvents.filter(e => {
            const eventId = e.id || e.eventId;
            return !existingIds.has(eventId);
          });

          // If there are new events, append them to the end
          if (newEvents.length > 0) {
            return [...prevEvents, ...newEvents];
          }

          // If no new events, return previous state (no re-render needed)
          return prevEvents;
        });

        setLastRefresh(new Date());

        // ✅ Update preview only if previewed event is selected and still exists
        if (previewEvent && previewData) {
          const updatedEvent = fetchedEvents.find(e => (e.id || e.eventId) === (previewEvent.id || previewEvent.eventId));
          if (updatedEvent) {
            try {
              const bitrixData = await shopifyAdapter.transformToBitrix(updatedEvent);
              setPreviewEvent(updatedEvent);
              setPreviewData({
                shopifyData: updatedEvent,
                bitrixData: bitrixData
              });
            } catch (error) {
              console.error('Error updating preview:', error);
            }
          }
        }
      } else {
        setError(data.error || 'Failed to fetch events');
      }
    } catch (err) {
      console.error('Fetch events error:', err);
      setError(err.message || 'Network error');
    }
  };

  const fetchBitrixEvents = async () => {
    // ✅ Don't set loading state - we'll show inline loader for new rows only

    try {
      const response = await fetch('/api/events/bitrix');
      const data = await response.json();

      if (data.success) {
        const fetchedEvents = data.events || [];

        // ✅ Smart merge: only add new events, preserve existing ones
        setBitrixEvents(prevEvents => {
          const existingIds = new Set(prevEvents.map(e => e.id || e.eventId || e.dealId));
          const newEvents = fetchedEvents.filter(e => {
            const eventId = e.id || e.eventId || e.dealId;
            return !existingIds.has(eventId);
          });
          if (newEvents.length > 0) {
            return [...prevEvents, ...newEvents];
          }
          return prevEvents;
        });
      }
    } catch (err) {
      console.error('Fetch Bitrix events error:', err);
    }
  };

  const fetchSuccessOperations = async () => {
    // ✅ Don't set loading state - we'll show inline loader for new rows only

    try {
      const response = await fetch('/api/events/success');
      const data = await response.json();

      if (data.success) {
        const fetchedOperations = data.operations || [];

        // ✅ Smart merge: only add new operations, preserve existing ones
        setSuccessOperations(prevOperations => {
          const existingIds = new Set(prevOperations.map(op => op.id || op.operationId));
          const newOperations = fetchedOperations.filter(op => {
            const opId = op.id || op.operationId;
            return !existingIds.has(opId);
          });
          if (newOperations.length > 0) {
            return [...prevOperations, ...newOperations];
          }
          return prevOperations;
        });

        // ✅ Update preview only if previewed operation is selected
        if (successPreviewOperation && previewData) {
          const updatedOp = fetchedOperations.find(op => (op.id || op.operationId) === (successPreviewOperation.id || successPreviewOperation.operationId));
          if (updatedOp) {
            setSuccessPreviewOperation(updatedOp);
            setPreviewData({
              shopifyData: null,
              bitrixData: updatedOp.dealData ? { fields: updatedOp.dealData } : { fields: {} },
              operation: updatedOp
            });
          }
        }
      }
    } catch (err) {
      console.error('Fetch success operations error:', err);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchBitrixWebhookUrl(); // Fetch webhook URL first

    // First load - set loading states
    setIsLoading(true);
    setIsBitrixLoading(true);
    setIsSuccessLoading(true);

    Promise.all([
      fetchEvents(),
      fetchBitrixEvents(),
      fetchSuccessOperations()
    ]).finally(() => {
      setIsLoading(false);
      setIsBitrixLoading(false);
      setIsSuccessLoading(false);
      setIsInitialFetch(false);
    });

    // Initial sync status fetch
    fetchSyncStatus();

    // Auto-refresh every 5 seconds (silent - no loading states, just fetch new data)
    const interval = setInterval(() => {
      fetchEvents();
      fetchBitrixEvents();
      fetchSuccessOperations();
      fetchSyncStatus(); // Poll sync status for UI updates
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const handleSendToBitrix = async () => {
    if (selectedEvents.length === 0) {
      alert('Выберите хотя бы одно событие для отправки');
      return;
    }

    if (!bitrixWebhookUrl || bitrixWebhookUrl.trim() === '') {
      if (isLoadingWebhookUrl) {
        alert('Пожалуйста, подождите пока загружается URL вебхука Bitrix');
      } else {
        alert('URL вебхука Bitrix не настроен. Проверьте переменную окружения BITRIX_WEBHOOK_BASE');
      }
      return;
    }

    setIsSending(true);
    setSendResult(null);

    try {
      const response = await fetch('/api/send-to-bitrix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedEvents,
          bitrixWebhookUrl: bitrixWebhookUrl.trim()
        })
      });

      const result = await response.json();

      if (response.ok || response.status === 207) {
        // 200 - все успешно, 207 - частичный успех
        setSendResult({
          success: result.success !== false,
          message: result.message,
          details: result.errors && result.errors.length > 0 ? result.errors : null,
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          results: result.results || [] // Store results for preview
        });
      } else {
        // 400, 500 - ошибки
        setSendResult({
          success: false,
          message: result.error || 'Failed to send',
          details: result.details || (result.errors && result.errors.length > 0 ? result.errors : null),
          results: result.results || [] // Store results for preview
        });
      }
    } catch (error) {
      console.error('Send to Bitrix error:', error);
      setSendResult({
        success: false,
        message: 'Network error',
        details: [{ error: error.message || 'Unknown network error' }]
      });
    } finally {
      setIsSending(false);
    }
  };

  const handlePreviewEvent = async (event) => {
    try {
      // Use API endpoint for server-side transformation (avoids client-side bundle issues)
      const response = await fetch('/api/transform-to-bitrix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shopifyOrder: event })
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || 'Failed to transform order');
      }

      setPreviewEvent(event);
      setPreviewData({
        shopifyData: event,
        bitrixData: result.bitrixData
      });
    } catch (error) {
      alert(`Ошибка при трансформации: ${error.message}`);
    }
  };

  const handleBitrixPreviewEvent = (event) => {
    // For Bitrix events, we have rawDealData from Bitrix
    // Show the raw Bitrix deal data
    setBitrixPreviewEvent(event);
    setBitrixPreviewData({
      bitrixData: event.rawDealData ? { fields: event.rawDealData } : { fields: event },
      shopifyData: null // Bitrix events don't have Shopify data in the event itself
    });
  };

  const handleSuccessPreviewOperation = (operation) => {
    // For success operations, show deal data
    setSuccessPreviewOperation(operation);
    setPreviewData({
      shopifyData: null,
      bitrixData: operation.dealData ? { fields: operation.dealData } : { fields: {} },
      operation: operation
    });
  };

  const handleDownloadLogs = async () => {
    try {
      // Download logs from API endpoint
      const response = await fetch('/api/logs/download');

      if (!response.ok) {
        throw new Error('Failed to download logs');
      }

      // Get the text content
      const logText = await response.text();

      // Create a blob and download
      const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shopify-bitrix-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading logs:', error);
      alert(`Ошибка при скачивании логов: ${error.message}`);
    }
  };


  const handleSendToShopify = async () => {
    if (selectedBitrixEvents.length === 0) {
      alert('Выберите хотя бы одно событие для отправки');
      return;
    }

    setIsSendingToShopify(true);
    setSendToShopifyResult(null);

    try {
      const response = await fetch('/api/send-to-shopify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedEvents: selectedBitrixEvents
        })
      });

      const result = await response.json();

      if (response.ok || response.status === 207) {
        // 200 - все успешно, 207 - частичный успех
        setSendToShopifyResult({
          success: result.success !== false,
          message: result.message,
          details: result.errors && result.errors.length > 0 ? result.errors : null,
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          results: result.results || []
        });
      } else {
        // 400, 500 - ошибки
        setSendToShopifyResult({
          success: false,
          message: result.error || 'Failed to send',
          details: result.details || (result.errors && result.errors.length > 0 ? result.errors : null),
          results: result.results || []
        });
      }
    } catch (error) {
      console.error('Send to Shopify error:', error);
      setSendToShopifyResult({
        success: false,
        message: 'Network error',
        details: [{ error: error.message || 'Unknown network error' }]
      });
    } finally {
      setIsSendingToShopify(false);
    }
  };

  const handlePreviewFromResult = (resultItem) => {
    if (resultItem.shopifyData && resultItem.bitrixData) {
      setPreviewEvent(resultItem.shopifyData);
      setPreviewData({
        shopifyData: resultItem.shopifyData,
        bitrixData: resultItem.bitrixData
      });
    }
  };

  const handleSelectAll = () => {
    if (events.length > 0) {
      setSelectedEvents(events);
    }
  };

  const handleDeselectAll = () => {
    setSelectedEvents([]);
  };

  const handleSendPreviewEvent = async () => {
    if (!previewEvent) {
      alert('Нет события для отправки');
      return;
    }

    if (!bitrixWebhookUrl || bitrixWebhookUrl.trim() === '') {
      if (isLoadingWebhookUrl) {
        alert('Пожалуйста, подождите пока загружается URL вебхука Bitrix');
      } else {
        alert('URL вебхука Bitrix не настроен. Проверьте переменную окружения BITRIX_WEBHOOK_BASE');
      }
      return;
    }

    setIsSending(true);
    setSendResult(null);

    try {
      const response = await fetch('/api/send-to-bitrix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedEvents: [previewEvent],
          bitrixWebhookUrl: bitrixWebhookUrl.trim()
        })
      });

      const result = await response.json();

      if (response.ok || response.status === 207) {
        setSendResult({
          success: result.success !== false,
          message: result.message,
          details: result.errors && result.errors.length > 0 ? result.errors : null,
          total: result.total,
          successful: result.successful,
          failed: result.failed,
          results: result.results || []
        });
      } else {
        setSendResult({
          success: false,
          message: result.error || 'Failed to send',
          details: result.details || (result.errors && result.errors.length > 0 ? result.errors : null),
          results: result.results || []
        });
      }
    } catch (error) {
      console.error('Send to Bitrix error:', error);
      setSendResult({
        success: false,
        message: 'Network error',
        details: [{ error: error.message || 'Unknown network error' }]
      });
    } finally {
      setIsSending(false);
    }
  };



  return (
    <>
      <Head>
        <title>Shopify Webhook - API Services</title>
        <meta name="description" content="Monitor Shopify webhook events" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </Head>
      <main className="page">
        <header className="page-header">
          <div>
            <h1>Webhook Monitor</h1>
            <p className="subtitle">
              Monitor Shopify → Bitrix and Bitrix → Shopify webhook events in real-time
            </p>
          </div>
          <div className="header-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
            {events.length > 0 && (
              <>
                {selectedEvents.length === events.length ? (
                  <button
                    onClick={handleDeselectAll}
                    className="btn"
                    style={{
                      background: '#6b7280',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      color: 'white',
                      cursor: 'pointer',
                      minWidth: '180px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    Снять выбор
                  </button>
                ) : (
                  <button
                    onClick={handleSelectAll}
                    className="btn"
                    style={{
                      background: '#3b82f6',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      color: 'white',
                      cursor: 'pointer',
                      minWidth: '180px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    ✓ Выбрать все ({events.length})
                  </button>
                )}
              </>
            )}
            <button
              onClick={handleSendToBitrix}
              className="btn"
              disabled={isSending || selectedEvents.length === 0}
              style={{
                background: selectedEvents.length > 0 ? '#059669' : '#6b7280',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                color: 'white',
                cursor: selectedEvents.length > 0 ? 'pointer' : 'not-allowed',
                minWidth: '220px',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              {isSending ? 'Отправка...' : `📤 Отправить в Bitrix (${selectedEvents.length})`}
            </button>
            <button
              onClick={handleDownloadLogs}
              className="btn"
              style={{
                background: '#7c3aed',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                color: 'white',
                cursor: 'pointer',
                minWidth: '220px',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
              title="Download integration logs (Shopify→Bitrix and Bitrix→Shopify) as .txt file"
            >
              📜 Скачать логи
            </button>
            {bitrixEvents.length > 0 && (
              <>
                {selectedBitrixEvents.length === bitrixEvents.length ? (
                  <button
                    onClick={() => setSelectedBitrixEvents([])}
                    className="btn"
                    style={{
                      background: '#6b7280',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      color: 'white',
                      cursor: 'pointer',
                      minWidth: '200px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    Снять выбор (Bitrix)
                  </button>
                ) : (
                  <button
                    onClick={() => setSelectedBitrixEvents(bitrixEvents)}
                    className="btn"
                    style={{
                      background: '#3b82f6',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      color: 'white',
                      cursor: 'pointer',
                      minWidth: '200px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0
                    }}
                  >
                    ✓ Выбрать все Bitrix ({bitrixEvents.length})
                  </button>
                )}
              </>
            )}
            <button
              onClick={handleSendToShopify}
              className="btn"
              disabled={isSendingToShopify || selectedBitrixEvents.length === 0}
              style={{
                background: selectedBitrixEvents.length > 0 ? '#059669' : '#6b7280',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                color: 'white',
                cursor: selectedBitrixEvents.length > 0 ? 'pointer' : 'not-allowed',
                minWidth: '220px',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              {isSendingToShopify ? 'Отправка...' : `📤 Отправить в Shopify (${selectedBitrixEvents.length})`}
            </button>
            <button
              onClick={() => {
                fetchEvents();
                fetchBitrixEvents();
                fetchSuccessOperations();
              }}
              className="btn"
              disabled={isLoading || isBitrixLoading || isSuccessLoading}
              style={{
                background: '#374151',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                color: 'white',
                cursor: (isLoading || isBitrixLoading || isSuccessLoading) ? 'not-allowed' : 'pointer',
                minWidth: '140px',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              {(isLoading || isBitrixLoading || isSuccessLoading) ? 'Refreshing...' : '🔄 Refresh'}
            </button>
          </div>
        </header>

        {sendResult && (
          <div style={{
            padding: '16px',
            borderRadius: '8px',
            marginBottom: '20px',
            background: sendResult.success ? 'rgba(5, 150, 105, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${sendResult.success ? '#059669' : '#ef4444'}`,
            color: sendResult.success ? '#059669' : '#ef4444'
          }}>
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>
              {sendResult.message}
            </div>
            {sendResult.total !== undefined && (
              <div style={{ fontSize: '0.9rem', marginTop: '8px', opacity: 0.9 }}>
                Всего: {sendResult.total} | Успешно: {sendResult.successful || 0} | Ошибок: {sendResult.failed || 0}
              </div>
            )}
            {sendResult.details && sendResult.details.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${sendResult.success ? 'rgba(5, 150, 105, 0.3)' : 'rgba(239, 68, 68, 0.3)'}` }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Детали ошибок:</div>
                {sendResult.details.map((err, idx) => (
                  <div key={idx} style={{
                    fontSize: '0.8rem',
                    marginBottom: '6px',
                    padding: '6px 8px',
                    background: 'rgba(0, 0, 0, 0.2)',
                    borderRadius: '4px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      {err.eventId && <strong>Event ID {err.eventId}: </strong>}
                      {err.error || err.message || 'Unknown error'}
                      {err.details && <div style={{ marginTop: '4px', opacity: 0.8 }}>{err.details}</div>}
                      {err.status && <div style={{ marginTop: '4px', opacity: 0.8 }}>HTTP {err.status}: {err.statusText || ''}</div>}
                    </div>
                    {(err.shopifyData && err.bitrixData) && (
                      <button
                        onClick={() => handlePreviewFromResult(err)}
                        style={{
                          padding: '4px 8px',
                          background: '#3b82f6',
                          border: 'none',
                          borderRadius: '4px',
                          color: '#f1f5f9',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          marginLeft: '8px'
                        }}
                      >
                        👁️ Preview
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {sendResult.results && sendResult.results.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${sendResult.success ? 'rgba(5, 150, 105, 0.3)' : 'rgba(239, 68, 68, 0.3)'}` }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Результаты отправки:</div>
                {sendResult.results.map((result, idx) => (
                  <div key={idx} style={{
                    fontSize: '0.8rem',
                    marginBottom: '6px',
                    padding: '6px 8px',
                    background: result.success ? 'rgba(5, 150, 105, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    borderRadius: '4px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      {result.eventId && <strong>Event ID {result.eventId}: </strong>}
                      {result.success ? '✓ Успешно отправлено' : (result.error || 'Ошибка отправки')}
                      {result.status && <div style={{ marginTop: '4px', opacity: 0.8 }}>HTTP {result.status}</div>}
                    </div>
                    {(result.shopifyData && result.bitrixData) && (
                      <button
                        onClick={() => handlePreviewFromResult(result)}
                        style={{
                          padding: '4px 8px',
                          background: '#3b82f6',
                          border: 'none',
                          borderRadius: '4px',
                          color: '#f1f5f9',
                          cursor: 'pointer',
                          fontSize: '0.75rem',
                          marginLeft: '8px'
                        }}
                      >
                        👁️ Preview
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {lastRefresh && (
          <div style={{
            padding: '8px 16px',
            background: 'rgba(59, 130, 246, 0.1)',
            borderRadius: '8px',
            marginBottom: '20px',
            fontSize: '0.9rem',
            color: '#94a3b8'
          }}>
            Last refreshed: {lastRefresh.toLocaleTimeString()} (Auto-refresh every 5s)
          </div>
        )}

        {error && (
          <div className="alert alert-error">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Webhook Configuration */}
        <WebhookInfo onBitrixUrlChange={setBitrixWebhookUrl} />

        {/* Inventory Sync Section */}
        <div style={{
          marginTop: '30px',
          padding: '20px',
          background: 'rgba(15, 23, 42, 0.6)',
          borderRadius: '12px',
          border: '1px solid rgba(59, 130, 246, 0.2)'
        }}>
          <h2 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.3rem' }}>
            Синхронизация каталога
          </h2>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleSyncInventory}
              disabled={syncStatus.isRunning}
              style={{
                background: syncStatus.isRunning ? '#6b7280' : '#059669',
                border: 'none',
                padding: '10px 20px',
                borderRadius: '6px',
                color: 'white',
                cursor: syncStatus.isRunning ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 500,
                minWidth: '180px'
              }}
              title="Запустить синхронизацию товаров (автоматически каждые 4 часа)"
            >
              {syncStatus.isRunning ? '⏳ Выполняется...' : '🔄 Синхронизировать'}
            </button>

            <select
              value={selectedSectionId}
              onChange={(e) => setSelectedSectionId(e.target.value)}
              disabled={syncStatus.isRunning}
              style={{
                padding: '10px 16px',
                borderRadius: '6px',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                background: 'rgba(30, 41, 59, 0.8)',
                color: '#f1f5f9',
                fontSize: '1rem',
                cursor: syncStatus.isRunning ? 'not-allowed' : 'pointer',
                minWidth: '160px'
              }}
            >
              {SECTION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {syncStatus.isRunning && (
              <span style={{ color: '#fbbf24', fontSize: '0.9rem', fontWeight: 500 }}>
                ⏳ Синхронизация в процессе...
              </span>
            )}
          </div>

          {inventorySyncResult && (
            <div style={{
              marginTop: '16px',
              padding: '12px',
              borderRadius: '8px',
              background: inventorySyncResult.success ? 'rgba(5, 150, 105, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              border: `1px solid ${inventorySyncResult.success ? '#059669' : '#ef4444'}`,
              color: inventorySyncResult.success ? '#059669' : '#ef4444',
              fontSize: '0.95rem'
            }}>
              {inventorySyncResult.success ? '✅' : '❌'} {inventorySyncResult.message}
            </div>
          )}

          {syncStatus.lastRun && (
            <div style={{ marginTop: '12px', fontSize: '0.85rem', color: '#94a3b8' }}>
              Последний запуск: {new Date(syncStatus.lastRun.endTime).toLocaleString()} •
              {syncStatus.lastRun.success ? ' ✅ Успешно' : ' ❌ С ошибками'} •
              {syncStatus.lastRun.durationMinutes} мин
            </div>
          )}
        </div>

        {/* Events Lists - Three fixed-width columns: Shopify → Bitrix, Bitrix → Shopify, Success Operations */}
        <div style={{
          display: 'flex',
          gap: '20px',
          marginTop: '20px',
          alignItems: 'flex-start'
        }}>
          {/* Left column: Shopify → Bitrix - Fixed width */}
          <div style={{ width: '400px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.5rem', flexShrink: 0 }}>
              Shopify → Middleware → Bitrix
            </h2>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <EventsList
                events={events}
                selectedEvents={selectedEvents}
                onSelectionChange={setSelectedEvents}
                onPreviewEvent={handlePreviewEvent}
                isLoading={isInitialFetch && isLoading}
              />
            </div>
          </div>

          {/* Middle column: Bitrix → Shopify - Fixed width */}
          <div style={{ width: '400px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.5rem', flexShrink: 0 }}>
              Bitrix → Middleware → Shopify
            </h2>
            {sendToShopifyResult && (
              <div style={{
                padding: '16px',
                borderRadius: '8px',
                marginBottom: '20px',
                background: sendToShopifyResult.success ? 'rgba(5, 150, 105, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                border: `1px solid ${sendToShopifyResult.success ? '#059669' : '#ef4444'}`,
                color: sendToShopifyResult.success ? '#059669' : '#ef4444',
                flexShrink: 0
              }}>
                <div style={{ fontWeight: 600, marginBottom: '8px' }}>
                  {sendToShopifyResult.message}
                </div>
                {sendToShopifyResult.total !== undefined && (
                  <div style={{ fontSize: '0.9rem', marginTop: '8px', opacity: 0.9 }}>
                    Всего: {sendToShopifyResult.total} | Успешно: {sendToShopifyResult.successful || 0} | Ошибок: {sendToShopifyResult.failed || 0}
                  </div>
                )}
                {sendToShopifyResult.details && sendToShopifyResult.details.length > 0 && (
                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${sendToShopifyResult.success ? 'rgba(5, 150, 105, 0.3)' : 'rgba(239, 68, 68, 0.3)'}` }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Детали ошибок:</div>
                    {sendToShopifyResult.details.map((err, idx) => (
                      <div key={idx} style={{
                        fontSize: '0.8rem',
                        marginBottom: '6px',
                        padding: '6px 8px',
                        background: 'rgba(0, 0, 0, 0.2)',
                        borderRadius: '4px'
                      }}>
                        {err.eventId && <strong>Event ID {err.eventId}: </strong>}
                        {err.error || err.message || 'Unknown error'}
                        {err.details && <div style={{ marginTop: '4px', opacity: 0.8 }}>{err.details}</div>}
                        {err.status && <div style={{ marginTop: '4px', opacity: 0.8 }}>HTTP {err.status}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <BitrixEventsList
                events={bitrixEvents}
                selectedEvents={selectedBitrixEvents}
                onSelectionChange={setSelectedBitrixEvents}
                onPreviewEvent={handleBitrixPreviewEvent}
                isLoading={isInitialFetch && isBitrixLoading}
              />
            </div>
          </div>

          {/* Right column: Success Operations - Fixed width */}
          <div style={{ width: '400px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.5rem', flexShrink: 0 }}>
              ✓ Успешные операции (Тестирование)
            </h2>
            <div style={{ flex: '1 1 auto', minHeight: 0 }}>
              <SuccessOperationsList
                operations={successOperations}
                selectedOperations={selectedSuccessOperations}
                onSelectionChange={setSelectedSuccessOperations}
                onPreviewOperation={handleSuccessPreviewOperation}
                isLoading={isInitialFetch && isSuccessLoading}
              />
            </div>
          </div>
        </div>

        {/* Data Preview - Wide block below */}
        {(previewData && previewEvent) || (bitrixPreviewData && bitrixPreviewEvent) || (previewData && successPreviewOperation) ? (
          <div style={{ marginTop: '20px', width: '100%' }}>
            {previewData && previewEvent && !successPreviewOperation && (
              <DataPreview
                shopifyData={previewData.shopifyData}
                bitrixData={previewData.bitrixData}
                eventId={previewEvent.id}
                onSendEvent={handleSendPreviewEvent}
                isSending={isSending}
              />
            )}
            {bitrixPreviewData && bitrixPreviewEvent && (
              <DataPreview
                shopifyData={bitrixPreviewData.shopifyData}
                bitrixData={bitrixPreviewData.bitrixData}
                eventId={bitrixPreviewEvent.dealId || bitrixPreviewEvent.id}
                eventType="bitrix"
              />
            )}
            {previewData && successPreviewOperation && (
              <DataPreview
                shopifyData={previewData.shopifyData}
                bitrixData={previewData.bitrixData}
                eventId={successPreviewOperation.dealId || successPreviewOperation.id}
                eventType="success"
                operation={successPreviewOperation}
              />
            )}
          </div>
        ) : null}
      </main>
    </>
  );
}
