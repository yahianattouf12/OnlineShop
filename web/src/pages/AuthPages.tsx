import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { authApi } from '../api/endpoints';
import type { User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Notice, ProblemNotice, TextField } from '../components/ui';

function AuthShell({ title, lead, children, footer }: { title: string; lead: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="main main-narrow">
      <div className="stack gap-xl" style={{ paddingTop: 'var(--space-xl)' }}>
        <div className="stack gap-sm">
          <h1 className="h3">{title}</h1>
          <p className="lead muted">{lead}</p>
        </div>
        {children}
        <p className="body-sm muted" style={{ textAlign: 'center' }}>
          {footer}
        </p>
      </div>
    </main>
  );
}

/** Where to go after logging in: back to the page that asked, or the role's home. */
function useAfterLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return (user: User) => navigate(from ?? (user.role === 'Admin' ? '/admin/orders' : '/products'), { replace: true });
}

/** Counts down the seconds from a 429's Retry-After header. */
function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds] as const;
}

export function LoginPage() {
  const { login, sessionExpired } = useAuth();
  const afterLogin = useAfterLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [lockedFor, setLockedFor] = useCountdown();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      afterLogin(await login(email, password));
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 429) setLockedFor(err.retryAfterSeconds ?? 60);
    } finally {
      setBusy(false);
    }
  };

  const fieldErrors = (field: string) => (error instanceof ApiError && error.status === 422 ? error.fieldErrors(field) : undefined);
  const locked = lockedFor > 0;

  return (
    <AuthShell
      title="Log in."
      lead="Welcome back. Use your email and password."
      footer={
        <>
          No account yet?{' '}
          <Link to="/register" className="text-link">
            Sign up
          </Link>
          .
        </>
      }
    >
      {sessionExpired && !error && (
        <Notice icon="lock" title="Your session ended.">
          Please log in again.
        </Notice>
      )}

      {locked ? (
        <Notice tone="error" icon="lock" title="Too many login attempts.">
          For your security, logging in is paused. Try again in{' '}
          <span className="strong tabular">{lockedFor} s</span>.
        </Notice>
      ) : error instanceof ApiError && error.status === 401 ? (
        <Notice tone="error" icon="alert" title="Wrong email or password.">
          Check both and try again.
        </Notice>
      ) : (
        !(error instanceof ApiError && error.status === 422) && <ProblemNotice error={error} />
      )}

      <form className="stack gap-lg" onSubmit={submit} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors('Email')}
          required
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors('Password')}
          required
        />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || locked}>
          {busy ? 'Logging in…' : locked ? `Try again in ${lockedFor} s` : 'Log in'}
        </button>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { login } = useAuth();
  const afterLogin = useAfterLogin();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>();
  const [confirmError, setConfirmError] = useState<string[]>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (password !== confirm) {
      setConfirmError(['The passwords don’t match.']);
      return;
    }
    setConfirmError(undefined);
    setBusy(true);
    try {
      await authApi.register(email, password);
      const user = await login(email, password);
      toast('Your account is ready.');
      afterLogin(user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError ? error : undefined;
  const emailError = apiError?.status === 409 ? [apiError.problem.detail ?? 'This email is already registered.'] : apiError?.fieldErrors('Email');
  const passwordError = apiError?.fieldErrors('Password');
  const showGeneric = error != null && !(apiError && (apiError.status === 409 || apiError.status === 422));

  return (
    <AuthShell
      title="Create your account."
      lead="Sign up to place orders and follow their status."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-link">
            Log in
          </Link>
          .
        </>
      }
    >
      {showGeneric && <ProblemNotice error={error} />}

      <form className="stack gap-lg" onSubmit={submit} noValidate>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
          required
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={passwordError}
          hint="At least 8 characters."
          required
        />
        <TextField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirmError}
          required
        />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? 'Creating account…' : 'Sign up'}
        </button>
        <p className="caption muted row gap-xs" style={{ justifyContent: 'center' }}>
          <Icon name="shield" size={14} />
          New accounts are always customers. Nobody can sign up as an admin.
        </p>
      </form>
    </AuthShell>
  );
}
