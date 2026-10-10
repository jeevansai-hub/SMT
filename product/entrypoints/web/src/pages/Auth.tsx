import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { homeFor } from '../auth/access';
import { Alert, Field, PageHeading } from '../components/ui';
import { ApiError } from '../api/client';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register, role, status } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string }>({});

  if (status === 'ready' && role) return <Navigate to={homeFor(role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) fe.email = 'Enter an email address like name@example.com.';
    if (password.length < (mode === 'register' ? 10 : 1))
      fe.password = mode === 'register' ? 'Use at least 10 characters.' : 'Enter your password.';
    setFieldErr(fe);
    setError(null);
    if (fe.email || fe.password) return;
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name.trim());
      nav('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'The email or password is not right. Check them and try again.'
          : mode === 'register'
            ? 'We could not create the account. Check your details and try again.'
            : 'We could not sign you in. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="container narrow">
      <p className="brand">Crucible</p>
      <PageHeading>{mode === 'login' ? 'Sign in' : 'Create your learner account'}</PageHeading>
      <p className="muted">
        {mode === 'login'
          ? 'Continue your skills assessment.'
          : 'Prove what you can do on your own work. Your results are yours, and you choose who sees them.'}
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <form onSubmit={submit} noValidate>
        {mode === 'register' ? (
          <Field id="name" label="Display name (optional)" hint="Only you see this. Others see an alias.">
            {(p) => <input {...p} type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        ) : null}
        <Field id="email" label="Email" error={fieldErr.email}>
          {(p) => (
            <input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field id="password" label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined} error={fieldErr.password}>
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Please wait' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {mode === 'login' ? (
          <div style={{ marginTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <span className="eyebrow" style={{ textAlign: 'center', display: 'block' }}>Instant Role Sign-In</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
              <a
                href="/api/auth/demo-session?role=recruiter&redirect=/hr"
                className="btn secondary"
                style={{ textAlign: 'center', fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}
              >
                👔 Recruiter Portal
              </a>
              <a
                href="/api/auth/demo-session?role=auditor&redirect=/audit"
                className="btn secondary"
                style={{ textAlign: 'center', fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}
              >
                🛡️ Auditor / Admitter
              </a>
              <a
                href="/api/auth/demo-session?role=reviewer&redirect=/review"
                className="btn secondary"
                style={{ textAlign: 'center', fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}
              >
                📝 Reviewer Console
              </a>
              <a
                href="/api/auth/demo-session?role=learner&track=python&redirect=/path"
                className="btn secondary"
                style={{ textAlign: 'center', fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}
              >
                ⚡ Learner Sandbox
              </a>
            </div>
          </div>
        ) : null}
      </form>
      <p style={{ marginTop: 'var(--space-4)' }}>
        {mode === 'login' ? (
          <>
            New here? <Link to="/register">Create a learner account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link to="/login">Sign in</Link>
          </>
        )}
      </p>
    </main>
  );
}
