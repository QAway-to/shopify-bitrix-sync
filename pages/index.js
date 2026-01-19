import Head from 'next/head';
import { useState, useEffect } from 'react';
import WebhookInfo from '../src/components/shopify/WebhookInfo';
import EventsList from '../src/components/shopify/EventsList';
import BitrixEventsList from '../src/components/bitrix/EventsList';
import SuccessOperationsList from '../src/components/success/SuccessOperationsList';
import DataPreview from '../src/components/shopify/DataPreview';
import LockedSection from '../src/components/common/LockedSection';

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
  // Track if this is initial fetch to show loading state
  const [isControlsUnlocked, setIsControlsUnlocked] = useState(false); // Lock state for control buttons
  const [unlockPasswordInput, setUnlockPasswordInput] = useState(''); // Password input for unlock
  const [unlockError, setUnlockError] = useState('');
  const [isInitialFetch, setIsInitialFetch] = useState(true);
  // Inventory sync state
  const [syncStatus, setSyncStatus] = useState({ isRunning: false, lastRun: null });
  const [selectedSectionId, setSelectedSectionId] = useState('all');
  const [inventorySyncResult, setInventorySyncResult] = useState(null);

  // Section options for dropdown
  const SECTION_OPTIONS = [
    { value: 'all', label: 'All sections' },
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
      setSyncStatus({
        isRunning: data.isRunning,
        lastRun: data.lastRun,
        nextSyncIn: data.nextSyncIn,
        nextSyncAt: data.nextSyncAt,
        nextSyncCyprus: data.nextSyncCyprus,
        schedule: data.schedule
      });
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
          message: `Sync started for ${selectedSectionId === 'all' ? 'all sections' : SECTION_OPTIONS.find(o => o.value === selectedSectionId)?.label}. Check logs.`,
          requestId: data.requestId
        });
        setSyncStatus({ isRunning: true, lastRun: syncStatus.lastRun });
      } else {
        setInventorySyncResult({
          success: false,
          message: data.error || 'Failed to start sync'
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
      alert('Please select at least one event to send');
      return;
    }

    if (!bitrixWebhookUrl || bitrixWebhookUrl.trim() === '') {
      if (isLoadingWebhookUrl) {
        alert('Please wait while Bitrix webhook URL is loading');
      } else {
        alert('Bitrix webhook URL not configured. Check BITRIX_WEBHOOK_BASE env variable');
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
      alert(`Transform error: ${error.message}`);
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
      alert(`Error downloading logs: ${error.message}`);
    }
  };


  const handleSendToShopify = async () => {
    if (selectedBitrixEvents.length === 0) {
      alert('Please select at least one event to send');
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
      alert('No event to send');
      return;
    }

    if (!bitrixWebhookUrl || bitrixWebhookUrl.trim() === '') {
      if (isLoadingWebhookUrl) {
        alert('Please wait while Bitrix webhook URL is loading');
      } else {
        alert('Bitrix webhook URL not configured. Check BITRIX_WEBHOOK_BASE env variable');
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

  // Handle unlock controls with password
  const handleUnlockControls = async () => {
    setUnlockError('');
    if (!unlockPasswordInput.trim()) {
      setUnlockError('Enter password');
      return;
    }
    try {
      const res = await fetch('/api/config/password');
      const data = await res.json();
      if (data.success && data.password === unlockPasswordInput.trim()) {
        setIsControlsUnlocked(true);
        setUnlockPasswordInput('');
      } else {
        setUnlockError('Wrong password');
      }
    } catch (err) {
      setUnlockError('Error');
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
        {/* Navigation Links */}
        <nav style={{ display: 'flex', gap: '20px', marginBottom: '20px', padding: '12px 0', borderBottom: '1px solid rgba(59, 130, 246, 0.2)' }}>
          <a href="/instruction" style={{ color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>Instructions</a>
          <a href="/tech_doc" style={{ color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>Tech Docs</a>
          <a href="/report" style={{ color: '#3b82f6', textDecoration: 'none', fontWeight: 500 }}>Reports</a>
        </nav>

        <header className="page-header">
          <div>
            <h3 style={{ fontSize: '1.5rem', marginBottom: '8px' }}>Webhook Monitor</h3>
            <p className="subtitle">
              Monitor Shopify ↔ Bitrix webhook events in real-time
            </p>
          </div>
          <LockedSection isGuestMode={!isControlsUnlocked} title="Controls Locked">
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
                        minWidth: '120px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      Deselect All
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
                        minWidth: '120px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      Select All ({events.length})
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
                  minWidth: '120px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {isSending ? '...' : `To Bitrix (${selectedEvents.length})`}
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
                  minWidth: '120px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
                title="Download integration logs"
              >
                Logs
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
                        minWidth: '120px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      Deselect Bitrix
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
                        minWidth: '120px',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                    >
                      Select Bitrix ({bitrixEvents.length})
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
                  minWidth: '120px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {isSendingToShopify ? '...' : `To Shop (${selectedBitrixEvents.length})`}
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
                  minWidth: '120px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
              >
                {(isLoading || isBitrixLoading || isSuccessLoading) ? '...' : 'Refresh'}
              </button>
            </div>
          </LockedSection>
          {/* Unlock Controls */}
          {!isControlsUnlocked && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}>
              <input
                type="password"
                value={unlockPasswordInput}
                onChange={(e) => setUnlockPasswordInput(e.target.value)}
                placeholder="Password"
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: unlockError ? '1px solid #ef4444' : '1px solid #334155',
                  background: '#0f172a',
                  color: '#f1f5f9',
                  fontSize: '0.9rem',
                  width: '120px'
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleUnlockControls()}
              />
              <button
                onClick={handleUnlockControls}
                style={{
                  padding: '8px 16px',
                  background: '#3b82f6',
                  border: 'none',
                  borderRadius: '6px',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Unlock
              </button>
              {unlockError && <span style={{ color: '#ef4444', fontSize: '0.85rem' }}>{unlockError}</span>}
            </div>
          )}
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
                Total: {sendResult.total} | Success: {sendResult.successful || 0} | Errors: {sendResult.failed || 0}
              </div>
            )}
            {sendResult.details && sendResult.details.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${sendResult.success ? 'rgba(5, 150, 105, 0.3)' : 'rgba(239, 68, 68, 0.3)'}` }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Error details:</div>
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
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Send results:</div>
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
                      {result.success ? '✓ Sent successfully' : (result.error || 'Send error')}
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
          <h3 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.2rem' }}>
            Inventory Sync
          </h3>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleSyncInventory}
              disabled={syncStatus.isRunning || !isControlsUnlocked}
              style={{
                background: !isControlsUnlocked ? '#475569' : syncStatus.isRunning ? '#6b7280' : '#059669',
                border: 'none',
                padding: '10px 20px',
                borderRadius: '6px',
                color: 'white',
                cursor: (syncStatus.isRunning || !isControlsUnlocked) ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 500,
                minWidth: '120px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
              title={!isControlsUnlocked ? 'Unlock controls first' : 'Start inventory sync'}
            >
              {!isControlsUnlocked && <span>🔒</span>}
              {syncStatus.isRunning ? 'Running...' : 'Sync'}
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
                ⏳ Sync in progress...
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
              Last run: {new Date(syncStatus.lastRun.endTime).toLocaleString()} •
              {syncStatus.lastRun.success ? ' ✅ Success' : ' ❌ Failed'} •
              {syncStatus.lastRun.durationMinutes} min
            </div>
          )}

          {syncStatus.nextSyncIn && !syncStatus.isRunning && (
            <div style={{ marginTop: '8px', fontSize: '0.85rem', color: '#60a5fa' }}>
              Next <strong>autosync</strong>: {syncStatus.nextSyncIn} ({syncStatus.nextSyncCyprus})
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
            <h3 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.2rem', flexShrink: 0 }}>
              Shopify → Middleware → Bitrix
            </h3>
            <LockedSection isGuestMode={!isControlsUnlocked} title="Login to view events">
              <div style={{ flex: '1 1 auto', minHeight: 0 }}>
                <EventsList
                  events={events}
                  selectedEvents={selectedEvents}
                  onSelectionChange={setSelectedEvents}
                  onPreviewEvent={handlePreviewEvent}
                  isLoading={isInitialFetch && isLoading}
                />
              </div>
            </LockedSection>
          </div>

          {/* Middle column: Bitrix → Shopify - Fixed width */}
          <div style={{ width: '400px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.2rem', flexShrink: 0 }}>
              Bitrix → Middleware → Shopify
            </h3>
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
                    Total: {sendToShopifyResult.total} | Success: {sendToShopifyResult.successful || 0} | Errors: {sendToShopifyResult.failed || 0}
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
            <LockedSection isGuestMode={!isControlsUnlocked} title="Login to view events">
              <div style={{ flex: '1 1 auto', minHeight: 0 }}>
                <BitrixEventsList
                  events={bitrixEvents}
                  selectedEvents={selectedBitrixEvents}
                  onSelectionChange={setSelectedBitrixEvents}
                  onPreviewEvent={handleBitrixPreviewEvent}
                  isLoading={isInitialFetch && isBitrixLoading}
                />
              </div>
            </LockedSection>
          </div>

          {/* Right column: Success Operations - Fixed width */}
          <div style={{ width: '400px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ color: '#f1f5f9', marginBottom: '16px', fontSize: '1.2rem', flexShrink: 0 }}>
              Success Operations (Testing)
            </h3>
            <LockedSection isGuestMode={!isControlsUnlocked} title="Login to view operations">
              <div style={{ flex: '1 1 auto', minHeight: 0 }}>
                <SuccessOperationsList
                  operations={successOperations}
                  selectedOperations={selectedSuccessOperations}
                  onSelectionChange={setSelectedSuccessOperations}
                  onPreviewOperation={handleSuccessPreviewOperation}
                  isLoading={isInitialFetch && isSuccessLoading}
                />
              </div>
            </LockedSection>
          </div>
        </div>

        {/* Data Preview - Wide block below */}
        {(previewData && previewEvent) || (bitrixPreviewData && bitrixPreviewEvent) || (previewData && successPreviewOperation) ? (
          <LockedSection isGuestMode={!isControlsUnlocked} title="Login to view preview">
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
          </LockedSection>
        ) : null}
      </main>
    </>
  );
}
