import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson, postJson, setAuthToken, getAuthToken } from '../api/index.js';

interface AuthStatus {
  hasUsers: boolean;
  userCount: number;
}

interface LoginResponse {
  token: string;
  user: { id: string; username: string; role: string };
}

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const authStatus = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => getJson<AuthStatus>('/auth/status'),
    staleTime: 10_000,
  });

  const isBootstrap = authStatus.data && !authStatus.data.hasUsers;

  // Auto-switch to register if no users exist
  if (isBootstrap && mode === 'login') {
    setMode('register');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('Username and password are required.');
      return;
    }
    setLoading(true);

    try {
      if (mode === 'register') {
        await postJson('/auth/register', {
          username: username.trim(),
          password,
          role: isBootstrap ? 'operator' : 'user',
        });
        // After registration, auto-login
      }
      const res = await postJson<LoginResponse>('/auth/login', {
        username: username.trim(),
        password,
      });
      setAuthToken(res.token);
      onLogin();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <div className="brand-mark" style={{ margin: '0 auto 12px', fontSize: 32 }}>◆</div>
          <h1>los</h1>
          <p className="login-subtitle">
            {isBootstrap
              ? 'Create your operator account to get started.'
              : 'Sign in to your account.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="field-label">
            Username
            <input
              type="text"
              className="field-input"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(''); }}
              placeholder="username"
              autoFocus
              autoComplete="username"
              disabled={loading}
            />
          </label>

          <label className="field-label">
            Password
            <input
              type="password"
              className="field-input"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(''); }}
              placeholder={mode === 'register' ? 'min 6 characters' : 'password'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              disabled={loading}
            />
          </label>

          {error ? <div className="login-error">{error}</div> : null}

          <button type="submit" className="btn-primary login-btn" disabled={loading}>
            {loading
              ? (mode === 'register' ? 'Creating account…' : 'Signing in…')
              : (mode === 'register' ? 'Create Account' : 'Sign In')}
          </button>
        </form>

        {!isBootstrap ? (
          <p className="login-switch">
            {mode === 'login' ? (
              <>No account yet? <button type="button" className="link-btn" onClick={() => setMode('register')}>Create one</button></>
            ) : (
              <>Already have an account? <button type="button" className="link-btn" onClick={() => setMode('login')}>Sign in</button></>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Check if the user is authenticated (has a valid JWT or static token).
 * For an actual validity check, call GET /auth/me.
 */
export function isAuthenticated(): boolean {
  return Boolean(getAuthToken());
}

/**
 * Logout: clear the stored token.
 */
export function logout(): void {
  setAuthToken(undefined);
  window.location.hash = '';
  window.location.reload();
}
