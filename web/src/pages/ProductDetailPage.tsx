import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { productsApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { MAX_LINES, MAX_QUANTITY, useCart } from '../cart/CartContext';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { BackLink, ErrorPage, Notice } from '../components/ui';
import { formatDate, formatMoney } from '../lib/format';
import { useAsync } from '../lib/useAsync';

export function Stepper({ value, onChange, label }: { value: number; onChange: (value: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label="Decrease">
        <Icon name="minus" size={16} />
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= MAX_QUANTITY} aria-label="Increase">
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

export function ProductDetailPage() {
  const { id = '' } = useParams();
  const { user, isAdmin, isCustomer } = useAuth();
  const cart = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [quantity, setQuantity] = useState(1);
  const product = useAsync(() => productsApi.get(id), [id]);

  if (product.error) {
    return (
      <main className="main">
        <BackLink to="/products">Shop</BackLink>
        <ErrorPage error={product.error} notFoundTitle="This product doesn’t exist." notFoundText="It may have been removed, or the link is wrong." />
      </main>
    );
  }

  const p = product.data;
  const inCart = p ? cart.lines.find((l) => l.productId === p.id)?.quantity ?? 0 : 0;

  const addToCart = () => {
    if (!p) return;
    if (!cart.add(p, quantity)) {
      toast(`An order can hold up to ${MAX_LINES} different products.`);
      return;
    }
    toast(`Added ${quantity} × ${p.name} to your cart.`);
    setQuantity(1);
  };

  return (
    <main className="main">
      <BackLink to="/products">Shop</BackLink>
      {!p ? (
        <div className="product-detail" aria-hidden="true">
          <div className="skeleton" style={{ aspectRatio: '1', borderRadius: 'var(--radius-md)' }} />
          <div className="stack gap-md">
            <div className="skeleton" style={{ height: 24, width: 90 }} />
            <div className="skeleton" style={{ height: 48, width: '80%' }} />
            <div className="skeleton" style={{ height: 32, width: 120 }} />
          </div>
        </div>
      ) : (
        <div className="product-detail">
          <div className="product-media">
            <img src={p.imageUrl} alt={p.name} />
          </div>

          <div className="stack gap-xl">
            <div className="stack gap-md">
              <span className="badge badge-soft" style={{ alignSelf: 'flex-start', textTransform: 'capitalize' }}>
                {p.category}
              </span>
              <h1 className="h2">{p.name}</h1>
              <div className="price-lg tabular">{formatMoney(p.price)}</div>
            </div>

            {p.description && <p className="lead muted">{p.description}</p>}

            <hr className="divider" />

            {isCustomer && (
              <div className="stack gap-md">
                <div className="row gap-sm wrap">
                  <Stepper value={quantity} onChange={setQuantity} label="Quantity" />
                  <button type="button" className="btn btn-primary btn-lg grow" onClick={addToCart}>
                    <Icon name="bag" size={18} />
                    Add to cart · {formatMoney(p.price * quantity)}
                  </button>
                </div>
                {inCart > 0 && (
                  <div className="row between wrap gap-sm body-sm">
                    <span className="muted">
                      {inCart} already in your cart.
                    </span>
                    <Link to="/cart" className="text-link">
                      Go to cart
                    </Link>
                  </div>
                )}
              </div>
            )}

            {!user && (
              <div className="stack gap-sm">
                <button type="button" className="btn btn-primary btn-lg" onClick={() => navigate('/login', { state: { from: `/products/${p.id}` } })}>
                  Log in to order
                </button>
                <p className="body-sm muted">
                  New here?{' '}
                  <Link to="/register" className="text-link">
                    Create an account
                  </Link>
                  .
                </p>
              </div>
            )}

            {isAdmin && (
              <Notice icon="info" title="You’re signed in as the admin.">
                Admins manage the store and order statuses. Placing orders is for customer accounts.
              </Notice>
            )}

            <dl className="stack gap-xs body-sm" style={{ margin: 0 }}>
              <div className="summary-row">
                <dt className="muted">Added</dt>
                <dd style={{ margin: 0 }}>{formatDate(p.createdAt)}</dd>
              </div>
              <div className="summary-row">
                <dt className="muted">Product id</dt>
                <dd style={{ margin: 0 }} className="mono">
                  {p.id}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </main>
  );
}
