import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { EmptyState } from './components/ui';
import { AddProductPage, UsersPage } from './pages/AdminPages';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { CartPage } from './pages/CartPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ProductsPage } from './pages/ProductsPage';
import { SecurityPage } from './pages/SecurityPage';

function NotFoundPage() {
  return (
    <main className="main">
      <EmptyState
        icon="search"
        title="This page doesn’t exist."
        action={
          <Link to="/products" className="btn btn-primary">
            Back to the shop
          </Link>
        }
      />
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/products" replace />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="products/:id" element={<ProductDetailPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />

        <Route path="cart" element={<RequireAuth role="Customer"><CartPage /></RequireAuth>} />
        <Route path="orders" element={<RequireAuth role="Customer"><OrdersPage /></RequireAuth>} />
        <Route path="notifications" element={<RequireAuth role="Customer"><NotificationsPage /></RequireAuth>} />
        {/* Both roles: a customer sees only their own orders (the API answers 404 otherwise), the admin sees any. */}
        <Route path="orders/:id" element={<RequireAuth><OrderDetailPage /></RequireAuth>} />
        <Route path="security" element={<RequireAuth><SecurityPage /></RequireAuth>} />

        <Route path="admin/orders" element={<RequireAuth role="Admin"><OrdersPage admin /></RequireAuth>} />
        <Route path="admin/products/new" element={<RequireAuth role="Admin"><AddProductPage /></RequireAuth>} />
        <Route path="admin/users" element={<RequireAuth role="Admin"><UsersPage /></RequireAuth>} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
