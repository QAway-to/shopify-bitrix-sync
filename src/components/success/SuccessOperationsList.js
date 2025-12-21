import { useState } from 'react';

export default function SuccessOperationsList({ operations, selectedOperations, onSelectionChange, onPreviewOperation, isLoading = false }) {
  const [expandedOperations, setExpandedOperations] = useState(new Set());

  const toggleExpand = (operationId) => {
    const newExpanded = new Set(expandedOperations);
    if (newExpanded.has(operationId)) {
      newExpanded.delete(operationId);
    } else {
      newExpanded.add(operationId);
    }
    setExpandedOperations(newExpanded);
  };

  const handleCheckboxChange = (operation, checked) => {
    if (checked) {
      onSelectionChange([...selectedOperations, operation]);
    } else {
      onSelectionChange(selectedOperations.filter(op => op.id !== operation.id));
    }
  };

  const handleSelectAll = () => {
    onSelectionChange(operations);
  };

  const handleDeselectAll = () => {
    onSelectionChange([]);
  };

  if (operations.length === 0 && !isLoading) {
    return (
      <div style={{
        padding: '20px',
        textAlign: 'center',
        color: '#94a3b8',
        background: 'rgba(15, 23, 42, 0.5)',
        borderRadius: '8px',
        border: '1px solid rgba(148, 163, 184, 0.2)'
      }}>
        <p>Нет успешных операций</p>
        <p style={{ fontSize: '0.85rem', marginTop: '8px', opacity: 0.7 }}>
          Успешно созданные и обновленные сделки будут отображаться здесь
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '0.9rem', color: '#94a3b8' }}>
          Всего: {operations.length} | Выбрано: {selectedOperations.length}
        </div>
        {operations.length > 0 && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {selectedOperations.length === operations.length ? (
              <button
                onClick={handleDeselectAll}
                style={{
                  padding: '4px 8px',
                  background: '#6b7280',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '0.75rem'
                }}
              >
                Снять выбор
              </button>
            ) : (
              <button
                onClick={handleSelectAll}
                style={{
                  padding: '4px 8px',
                  background: '#3b82f6',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '0.75rem'
                }}
              >
                Выбрать все
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '600px', overflowY: 'auto' }}>
        {operations.map((operation) => {
          const isSelected = selectedOperations.some(op => op.id === operation.id);
          const isExpanded = expandedOperations.has(operation.id);
          const dealData = operation.dealData || {};
          const isCreate = operation.operationType === 'CREATE';
          const isUpdate = operation.operationType === 'UPDATE';
          const isVerified = operation.verified;

          return (
            <div
              key={operation.id}
              style={{
                background: isCreate 
                  ? 'rgba(5, 150, 105, 0.1)' 
                  : isUpdate 
                    ? 'rgba(59, 130, 246, 0.1)' 
                    : 'rgba(15, 23, 42, 0.5)',
                border: `1px solid ${isCreate 
                  ? 'rgba(5, 150, 105, 0.3)' 
                  : isUpdate 
                    ? 'rgba(59, 130, 246, 0.3)' 
                    : 'rgba(148, 163, 184, 0.2)'}`,
                borderRadius: '8px',
                padding: '12px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onClick={() => toggleExpand(operation.id)}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    e.stopPropagation();
                    handleCheckboxChange(operation, e.target.checked);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginTop: '4px', cursor: 'pointer' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          background: isCreate ? '#059669' : '#3b82f6',
                          color: 'white'
                        }}>
                          {isCreate ? '✓ СОЗДАНА' : isUpdate ? '✓ ОБНОВЛЕНА' : '✓ УСПЕХ'}
                        </span>
                        {isVerified && (
                          <span style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            background: '#10b981',
                            color: 'white'
                          }}>
                            ✓ ВЕРИФИЦИРОВАНА
                          </span>
                        )}
                      </div>
                      <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '4px' }}>
                        Сделка: {dealData.TITLE || dealData.ID || 'N/A'}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                        Deal ID: {operation.dealId} | Shopify: {operation.shopifyOrderName || operation.shopifyOrderId}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreviewOperation(operation);
                      }}
                      style={{
                        padding: '4px 8px',
                        background: '#3b82f6',
                        border: 'none',
                        borderRadius: '4px',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '0.75rem'
                      }}
                    >
                      👁️ Preview
                    </button>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: '8px' }}>
                    <div>Сумма: {dealData.OPPORTUNITY ? `${dealData.OPPORTUNITY} ${dealData.CURRENCY_ID || 'EUR'}` : 'N/A'}</div>
                    <div>Стадия: {dealData.STAGE_ID || 'N/A'}</div>
                    <div>Категория: {dealData.CATEGORY_ID || 'N/A'}</div>
                    {operation.attempt && <div>Попытка: {operation.attempt}</div>}
                    {operation.productRowsCount !== undefined && <div>Товаров: {operation.productRowsCount}</div>}
                    <div style={{ marginTop: '4px', opacity: 0.7 }}>
                      {new Date(operation.timestamp).toLocaleString('ru-RU')}
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{
                      marginTop: '12px',
                      padding: '12px',
                      background: 'rgba(0, 0, 0, 0.2)',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      color: '#cbd5e1'
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: '8px', color: '#f1f5f9' }}>Детали операции:</div>
                      <pre style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: '0.7rem',
                        color: '#cbd5e1'
                      }}>
                        {JSON.stringify(operation, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {/* ✅ Show loading indicator at the bottom if loading new data */}
        {isLoading && (
          <div style={{
            padding: '20px',
            textAlign: 'center',
            background: 'rgba(15, 23, 42, 0.5)',
            borderRadius: '8px',
            border: '1px solid rgba(148, 163, 184, 0.2)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#94a3b8' }}>
              <div style={{
                width: '16px',
                height: '16px',
                border: '2px solid #334155',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }}></div>
              <span>Loading new operations...</span>
            </div>
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        )}
      </div>
    </div>
  );
}

