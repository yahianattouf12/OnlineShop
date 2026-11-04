import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { configureClient } from '../api/client';
import { authApi } from '../api/endpoints';
import type { User } from '../api/types';

interface Session {
  token: string;
  expiresAtUtc: string;
  user: User;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAdmin: boolean;
  isCustomer: boolean;
  /** True until a stored session has been checked against /auth/me. */
  restoring: boolean;
  /** Set when the API rejected the stored token, so the login page can explain why. */
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
}

const STORAGE_KEY = 'onlineshop.session';
const AuthContext = createContext<AuthState | null>(null);

// sessionStorage: the token is gone when the tab closes. Fine for a demo; a production app would
// prefer an httpOnly cookie so scripts can never read the token.
function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return new Date(session.expiresAtUtc).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode); the session then lives only in memory.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readSession);
  const [restoring, setRestoring] = useState(() => readSession() !== null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const logout = useCallback(() => {
    writeSession(null);
    setSession(null);
  }, []);

  // The client reads the token from here and reports a rejected token back.
  useEffect(() => {
    configureClient({
      getToken: () => readSession()?.token ?? null,
      onUnauthorized: () => {
        writeSession(null);
        setSession(null);
        setSessionExpired(true);
      },
    });
  }, []);

  // Re-check a restored session once, so a token from an old database or an expired one is dropped.
  useEffect(() => {
    const stored = readSession();
    if (!stored) return;
    authApi
      .me(stored.token)
      .then((user) => {
        const fresh = { ...stored, user };
        writeSession(fresh);
        setSession(fresh);
      })
      .catch(() => {
        writeSession(null);
        setSession(null);
      })
      .finally(() => setRestoring(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    const user = await authApi.me(result.accessToken);
    const fresh = { token: result.accessToken, expiresAtUtc: result.expiresAtUtc, user };
    writeSession(fresh);
    setSession(fresh);
    setSessionExpired(false);
    return user;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      isAdmin: session?.user.role === 'Admin',
      isCustomer: session?.user.role === 'Customer',
      restoring,
      sessionExpired,
      login,
      logout,
    }),
    [session, restoring, sessionExpired, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
