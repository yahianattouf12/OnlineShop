import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { productsApi } from '../api/endpoints';
import type { Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { MAX_LINES, MAX_QUANTITY, useCart } from '../cart/CartContext';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { BackLink, ErrorPage, Notice, ProblemNotice, StockBadge, StockEditor, TextAreaField, TextField } from '../components/ui';
import { formatDate, formatMoney } from '../lib/format';
import { useAsync } from '../lib/useAsync';

export function Stepper({
  value,
  onChange,
  label,
  max = MAX_QUANTITY,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  /** Lower than MAX_QUANTITY when the stock is known to be lower. */
  max?: number;
}) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label="Decrease">
        <Icon name="minus" size={16} />
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Increase">
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

/**
 * Admin: edit the name, description, price and category (PUT /products/{id}). The API clears the product's
 * cached copies in Redis on save, and the ETag changes with the data, so shoppers see the change at once.
 */
function DetailsEditor({ product, onSaved }: { product: Product; onSaved: (saved: Product) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(String(product.price));
  const [description, setDescription] = useState(product.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const open = () => {
    setName(product.name);
    setCategory(product.category);
    setPrice(String(product.price));
    setDescription(product.description);
    setError(undefined);
    setEditing(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      // An empty or invalid price is sent as 0, so the API answers with its own "between 0.01 and 1,000,000" message.
      onSaved(await productsApi.update(product.id, { name, category, description, price: Number(price) || 0 }));
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const fieldErrors = error instanceof ApiError && error.problem.errors ? error : undefined;
  const errorsFor = (field: string) => fieldErrors?.fieldErrors(field);

  return (
    <div className="card-soft stack gap-md">
      <div className="row between wrap gap-sm">
        <div className="stack gap-xxs">
          <h2 className="title">Details.</h2>
          <p className="body-sm muted">Saved changes show at once, in the shop and on this page, even though products are cached.</p>
        </div>
        {!editing && (
          <button type="button" className="btn btn-outline btn-sm" onClick={open}>
            Edit details
          </button>
        )}
      </div>
      {editing && (
        <form className="stack gap-md" onSubmit={save} noValidate>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errorsFor('Name')} maxLength={200} />
          <div className="form-grid">
            <TextField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} error={errorsFor('Category')} maxLength={50} />
            <TextField
              label="Price (USD)"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              error={errorsFor('Price')}
            />
          </div>
          <TextAreaField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errorsFor('Description')}
            maxLength={2000}
            rows={4}
          />
          {error != null && !fieldErrors && <ProblemNotice error={error} />}
          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
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

  // The stock shown is a snapshot: the inventory service checks it again, for real, when the order is placed.
  const stock = p?.stock;
  const stockKnown = typeof stock === 'number';
  const canStillAdd = stockKnown ? Math.max(0, Math.min(MAX_QUANTITY, stock) - inCart) : MAX_QUANTITY - inCart;
  const amount = Math.max(1, Math.min(quantity, canStillAdd));

  const addToCart = () => {
    if (!p || canStillAdd <= 0) return;
    if (!cart.add(p, amount)) {
      toast(`An order can hold up to ${MAX_LINES} different products.`);
      return;
    }
    toast(`Added ${amount} × ${p.name} to your cart.`, { label: 'View cart', to: '/cart' });
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
              <div className="row gap-sm wrap">
                <div className="price-lg tabular">{formatMoney(p.price)}</div>
                <StockBadge stock={stock} />
              </div>
            </div>

            {p.description && <p className="lead muted">{p.description}</p>}

            <hr className="divider" />

            {stock === null && (
              <Notice icon="info" title="Availability unknown.">
                The inventory service isn’t answering right now, so we can’t show the stock.
                {isCustomer && ' You can still add this to your cart: the stock is checked when you place the order.'}
              </Notice>
            )}

            {isCustomer && (
              <div className="stack gap-md">
                {stock === 0 ? (
                  <button type="button" className="btn btn-primary btn-lg" disabled>
                    Out of stock
                  </button>
                ) : canStillAdd <= 0 ? (
                  <Notice icon="bag" title="Your cart already holds all you can order.">
                    {stockKnown ? `There ${stock === 1 ? 'is' : 'are'} ${stock} in stock.` : `Up to ${MAX_QUANTITY} per product.`}
                  </Notice>
                ) : (
                  <div className="row gap-sm wrap">
                    <Stepper value={amount} onChange={setQuantity} label="Quantity" max={canStillAdd} />
                    <button type="button" className="btn btn-primary btn-lg grow" onClick={addToCart}>
                      <Icon name="bag" size={18} />
                      Add to cart · {formatMoney(p.price * amount)}
                    </button>
                  </div>
                )}
                {inCart > 0 && (
                  <div className="row between wrap gap-sm body-sm">
                    <span className="muted">
                      {inCart} already in your cart.
                    </span>
                    <Link to="/cart" className="btn btn-outline">
                      <Icon name="bag" size={16} />
                      View cart
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
              <DetailsEditor
                product={p}
                onSaved={(saved) => {
                  // The answer to PUT has no stock (it lives in the inventory service): keep the one shown.
                  product.setData({ ...saved, stock: p.stock });
                  toast(`${saved.name} saved. Shoppers see the change now.`);
                }}
              />
            )}

            {isAdmin && (
              <div className="card-soft stack gap-md">
                <div className="stack gap-xxs">
                  <h2 className="title">Stock.</h2>
                  <p className="body-sm muted">
                    Kept by the inventory service, not by this app. Placing orders is for customer accounts.
                  </p>
                </div>
                <StockEditor
                  productId={p.id}
                  productName={p.name}
                  stock={stock}
                  onSaved={(saved) => {
                    product.setData({ ...p, stock: saved });
                    toast(`${p.name}: ${saved} in stock.`);
                  }}
                />
              </div>
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
