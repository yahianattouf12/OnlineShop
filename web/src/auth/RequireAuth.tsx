import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api/types';
import { EmptyState, Spinner } from '../components/ui';
import { useAuth } from './AuthContext';

/**
 * Hides pages from the wrong users. This is only for a good experience: the API checks every
 * request again on its own, so skipping this guard (e.g. calling the API directly) gets 401/403.
 */
export function RequireAuth({ role, children }: { role?: Role; children: ReactNode }) {
  const { user, restoring } = useAuth();
  const location = useLocation();

  if (restoring) {
    return (
      <main className="main row" style={{ justifyContent: 'center' }}>
        <Spinner />
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (role && user.role !== role) {
    return (
      <main className="main">
        <EmptyState
        icon="lock"
        title={role === 'Admin' ? 'Admins only.' : 'Customers only.'}
        action={
          <Link to="/" className="btn btn-primary">
            Back to the shop
          </Link>
        }
      >
        {role === 'Admin'
          ? 'This page manages the store. Log in with the admin account to use it.'
          : 'This page is for customer accounts. The admin manages orders from the Orders page.'}
        </EmptyState>
      </main>
    );
  }

  return <>{children}</>;
}
