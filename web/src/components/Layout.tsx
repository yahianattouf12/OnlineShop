import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useCart } from '../cart/CartContext';
import { useUnreadCount } from '../lib/unread';
import { Icon } from './Icon';

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9.6" fill="#141414" />
      <path d="M10 12h12l-1.2 10.2a2 2 0 0 1-2 1.8h-5.6a2 2 0 0 1-2-1.8L10 12Z" fill="#fff" />
      <path d="M13 12v-1a3 3 0 0 1 6 0v1" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) => `nav-link ${isActive ? 'active' : ''}`;

function NavItems() {
  const { user, isAdmin, isCustomer } = useAuth();
  const { count } = useCart();
  // Only customers receive notifications (about their own orders).
  const unread = useUnreadCount(isCustomer);

  return (
    <nav className="nav-links" aria-label="Main">
      <NavLink to="/products" className={linkClass}>
        Shop
      </NavLink>
      {isCustomer && (
        <>
          <NavLink to="/orders" className={linkClass}>
            My orders
          </NavLink>
          <NavLink to="/notifications" className={linkClass} aria-label={`Notifications, ${unread} unread`}>
            Notifications
            {unread > 0 && <span className="nav-count">{unread > 99 ? '99+' : unread}</span>}
          </NavLink>
          <NavLink to="/cart" className={linkClass} aria-label={`Cart, ${count} items`}>
            Cart
            {count > 0 && <span className="nav-count">{count > 99 ? '99+' : count}</span>}
          </NavLink>
        </>
      )}
      {isAdmin && (
        <>
          <NavLink to="/admin/orders" className={linkClass}>
            Orders
          </NavLink>
          <NavLink to="/admin/products/new" className={linkClass}>
            Add product
          </NavLink>
          <NavLink to="/admin/users" className={linkClass}>
            Users
          </NavLink>
        </>
      )}
      {user && (
        <NavLink to="/security" className={linkClass}>
          Security checks
        </NavLink>
      )}
    </nav>
  );
}

function UserArea() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    return (
      <div className="nav-user">
        <NavLink to="/login" className={linkClass}>
          Log in
        </NavLink>
        <Link to="/register" className="btn btn-primary">
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="nav-user">
      <span className="body-sm muted nav-email" title={user.email}>
        {user.email}
      </span>
      <span className="role-chip">{user.role}</span>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label="Log out"
        title="Log out"
        onClick={() => {
          logout();
          navigate('/products');
        }}
      >
        <Icon name="logout" />
      </button>
    </div>
  );
}

function NavBar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="nav-wrap">
      <div className="nav">
        <Link to="/products" className="brand" aria-label="OnlineShop home">
          <BrandMark />
          OnlineShop
        </Link>
        <NavItems />
        <UserArea />
        <button
          type="button"
          className="btn btn-ghost btn-icon nav-menu-button"
          aria-expanded={open}
          aria-controls="nav-panel"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'x' : 'menu'} />
        </button>
      </div>
      {open && (
        <div className="nav-panel" id="nav-panel">
          <NavItems />
          <UserArea />
        </div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="stack gap-sm">
          <div className="footer-wordmark">OnlineShop.</div>
          <p className="body-sm faint">Internet Applications course project · Requirement 1: API design and security.</p>
        </div>
        <div className="footer-links">
          <Link to="/products">Shop</Link>
          <a href="/swagger" target="_blank" rel="noreferrer">
            API docs (Swagger)
          </a>
          <Link to="/security">Security checks</Link>
        </div>
      </div>
    </footer>
  );
}

export function Layout() {
  const location = useLocation();
  // Braces matter: newer browsers return a Promise from scrollTo, and an effect may only return a cleanup function.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="app">
      <NavBar />
      <Outlet />
      <Footer />
    </div>
  );
}
