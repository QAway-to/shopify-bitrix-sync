import { sanitizeData } from '../../lib/utils/sanitize';

/**
 * Wrapper component that applies blur and lock icon in guest mode
 */
export default function LockedSection({ isGuestMode = false, children, title = null }) {
  if (!isGuestMode) {
    return <>{children}</>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        filter: 'blur(4px)',
        pointerEvents: 'none',
        userSelect: 'none',
        opacity: 0.7
      }}>
        {children}
      </div>
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '12px',
        pointerEvents: 'none'
      }}>
        <div style={{
          fontSize: '48px',
          opacity: 0.9,
          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))'
        }}>
          🔒
        </div>
        {title && (
          <div style={{
            color: '#f1f5f9',
            fontSize: '1.1rem',
            fontWeight: '500',
            textAlign: 'center',
            background: 'rgba(0, 0, 0, 0.7)',
            padding: '8px 16px',
            borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.2)'
          }}>
            {title}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Sanitize data if in guest mode
 */
export function useSanitizedData(data, isGuestMode) {
  if (!isGuestMode || !data) {
    return data;
  }
  return sanitizeData(data, isGuestMode);
}






