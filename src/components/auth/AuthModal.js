import { useState } from 'react';

export default function AuthModal({ onAuth, onGuest }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (password.trim() === '') {
      setError('Please enter password');
      return;
    }

    const success = await onAuth(password);
    if (!success) {
      setError('Incorrect password');
    }
  };

  const handleGuestMode = () => {
    onGuest();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.9)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999
    }}>
      <div style={{
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: '12px',
        padding: '32px',
        maxWidth: '400px',
        width: '90%',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)'
      }}>
        <h2 style={{
          color: '#f1f5f9',
          fontSize: '1.5rem',
          marginBottom: '24px',
          textAlign: 'center'
        }}>
          Authentication Required
        </h2>
        
        <form onSubmit={handleSubmit} style={{ marginBottom: '20px' }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{
              display: 'block',
              color: '#94a3b8',
              fontSize: '0.9rem',
              marginBottom: '8px'
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              placeholder="Enter password"
              style={{
                width: '100%',
                padding: '12px',
                background: '#0f172a',
                border: `1px solid ${error ? '#ef4444' : '#334155'}`,
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '1rem',
                outline: 'none',
                boxSizing: 'border-box'
              }}
              autoFocus
            />
            {error && (
              <div style={{
                color: '#ef4444',
                fontSize: '0.85rem',
                marginTop: '8px'
              }}>
                {error}
              </div>
            )}
          </div>
          
          <button
            type="submit"
            style={{
              width: '100%',
              padding: '12px',
              background: '#3b82f6',
              border: 'none',
              borderRadius: '8px',
              color: '#f1f5f9',
              fontSize: '1rem',
              fontWeight: '500',
              cursor: 'pointer',
              marginBottom: '12px'
            }}
          >
            Login
          </button>
        </form>

        <div style={{
          borderTop: '1px solid #334155',
          paddingTop: '20px',
          textAlign: 'center'
        }}>
          <p style={{
            color: '#94a3b8',
            fontSize: '0.9rem',
            marginBottom: '12px'
          }}>
            Or continue as guest (read-only, data sanitized)
          </p>
          <button
            onClick={handleGuestMode}
            style={{
              width: '100%',
              padding: '12px',
              background: '#475569',
              border: 'none',
              borderRadius: '8px',
              color: '#f1f5f9',
              fontSize: '1rem',
              fontWeight: '500',
              cursor: 'pointer'
            }}
          >
            Continue as Guest
          </button>
        </div>
      </div>
    </div>
  );
}




