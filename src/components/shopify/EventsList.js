import { sanitizeEmail } from '../../lib/utils/sanitize';

export default function EventsList({ events, onSelectionChange, selectedEvents = [], onPreviewEvent, isLoading = false, isGuestMode = false }) {
  // ✅ Show empty state only if no events AND not loading
  if ((!events || events.length === 0) && !isLoading) {
    return (
      <div className="card">
        <header className="card-header">
          <h2>Received Events</h2>
        </header>
        <div className="alert alert-info">
          <strong>No events yet</strong>
          <p>Webhook events will appear here once Shopify starts sending them.</p>
        </div>
      </div>
    );
  }

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
  };

  const handleSelectAll = (checked) => {
    if (isGuestMode) return; // Block in guest mode
    if (checked) {
      onSelectionChange(events);
    } else {
      onSelectionChange([]);
    }
  };

  const handleSelectEvent = (event, checked) => {
    if (isGuestMode) return; // Block in guest mode
    // Use event.id (unique event ID) for comparison, not orderId
    const eventId = event.id || event.eventId;
    
    if (checked) {
      // Only add if not already selected
      if (!selectedEvents.some(e => (e.id || e.eventId) === eventId)) {
        onSelectionChange([...selectedEvents, event]);
      }
    } else {
      // Remove by unique event ID
      onSelectionChange(selectedEvents.filter(e => (e.id || e.eventId) !== eventId));
    }
  };

  const isSelected = (event) => {
    // Use unique event ID for comparison
    const eventId = event.id || event.eventId;
    return selectedEvents.some(e => (e.id || e.eventId) === eventId);
  };

  const isAllSelected = events.length > 0 && selectedEvents.length === events.length;

  // Helper function to calculate total from active line items (matches Bitrix calculation)
  const calculateActiveItemsTotal = (event) => {
    if (!event.line_items || !Array.isArray(event.line_items)) {
      return event.current_total_price || event.total_price || 'N/A';
    }
    
    let total = 0;
    for (const item of event.line_items) {
      const currentQuantity = Number(item.current_quantity ?? item.quantity ?? 0);
      if (currentQuantity > 0) {
        const itemPrice = Number(item.price || 0);
        const itemTotal = itemPrice * currentQuantity;
        // Subtract discounts if present
        const itemDiscount = Number(
          item.discount_allocations?.[0]?.amount ||
          item.discount_allocations?.[0]?.amount_set?.shop_money?.amount ||
          item.total_discount ||
          0
        );
        total += itemTotal - itemDiscount;
      }
    }
    
    // Add shipping if present
    const shippingPrice = Number(
      event.current_total_shipping_price_set?.shop_money?.amount ||
      event.total_shipping_price_set?.shop_money?.amount ||
      event.shipping_price ||
      event.shipping_lines?.[0]?.price ||
      0
    );
    total += shippingPrice;
    
    // Fallback if calculation failed
    if (total === 0) {
      return event.current_total_price || event.total_price || 'N/A';
    }
    
    return total.toFixed(2);
  };

  return (
    <div className="card" style={{ width: '100%', minHeight: '300px', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <header className="card-header">
        <h2>Received Events</h2>
      </header>
      <div style={{ padding: '20px', flex: '1 1 auto', overflow: 'auto' }}>
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
            <div style={{ 
              display: 'inline-block',
              width: '32px',
              height: '32px',
              border: '3px solid rgba(59, 130, 246, 0.3)',
              borderTopColor: '#3b82f6',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
            <p style={{ marginTop: '16px' }}>Loading events...</p>
          </div>
        )}
        {!isLoading && events.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #334155' }}>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      disabled={isGuestMode}
                      style={{ cursor: isGuestMode ? 'not-allowed' : 'pointer', opacity: isGuestMode ? 0.5 : 1 }}
                    />
                  </th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>ID</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Email</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Total</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Currency</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Received At</th>
                  <th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => {
                  const eventId = event.id || event.eventId || `event-${index}`;
                  const orderId = event.orderId || event.id || 'N/A';
                  
                  return (
                    <tr 
                      key={eventId}
                      style={{ 
                        borderBottom: '1px solid #334155',
                        cursor: isGuestMode ? 'not-allowed' : 'pointer',
                        opacity: isGuestMode ? 0.7 : 1
                      }}
                      onClick={() => {
                        if (!isGuestMode && onPreviewEvent) {
                          onPreviewEvent(event);
                        }
                      }}
                    >
                      <td style={{ padding: '12px' }}>
                        <input
                          type="checkbox"
                          checked={isSelected(event)}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleSelectEvent(event, e.target.checked);
                          }}
                          disabled={isGuestMode}
                          onClick={(e) => e.stopPropagation()}
                          style={{ cursor: isGuestMode ? 'not-allowed' : 'pointer', opacity: isGuestMode ? 0.5 : 1 }}
                        />
                      </td>
                      <td style={{ padding: '12px', color: '#f1f5f9' }}>{orderId}</td>
                      <td style={{ padding: '12px', color: '#f1f5f9' }}>{isGuestMode ? sanitizeEmail(event.email, true) : (event.email || 'N/A')}</td>
                      <td style={{ padding: '12px', color: '#f1f5f9' }}>
                        {typeof calculateActiveItemsTotal(event) === 'number' || !isNaN(calculateActiveItemsTotal(event))
                          ? `${calculateActiveItemsTotal(event)} ${event.currency || 'EUR'}`
                          : calculateActiveItemsTotal(event)}
                      </td>
                      <td style={{ padding: '12px', color: '#f1f5f9' }}>{event.currency || 'EUR'}</td>
                      <td style={{ padding: '12px', color: '#f1f5f9' }}>{formatDate(event.received_at || event.created_at)}</td>
                      <td style={{ padding: '12px' }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!isGuestMode && onPreviewEvent) {
                              onPreviewEvent(event);
                            }
                          }}
                          disabled={isGuestMode}
                          style={{
                            padding: '6px 12px',
                            background: isGuestMode ? '#475569' : '#3b82f6',
                            border: 'none',
                            borderRadius: '6px',
                            color: '#f1f5f9',
                            cursor: isGuestMode ? 'not-allowed' : 'pointer',
                            fontSize: '0.85rem',
                            opacity: isGuestMode ? 0.5 : 1
                          }}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
