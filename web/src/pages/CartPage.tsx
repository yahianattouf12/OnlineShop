import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { ordersApi } from '../api/endpoints';
import type { StockShortage } from '../api/types';
import { MAX_QUANTITY, useCart } from '../cart/CartContext';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { EmptyState, Notice, PageHeader, ProblemNotice, StockBadge } from '../components/ui';
import { formatMoney } from '../lib/format';
import { isInventoryDown, loadStocks, shortagesOf } from '../lib/stock';
import { notificationsChanged } from '../lib/unread';
import { useAsync } from '../lib/useAsync';
import { Stepper } from './ProductDetailPage';

export function CartPage() {
  const cart = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [removedNames, setRemovedNames] = useState<string[]>([]);
  const [shortages, setShortages] = useState<StockShortage[]>([]);

  // A preview of the stock of each line, so a problem shows before ordering. Reloaded when the products change.
  // It is only a hint: the inventory service decides, for real and all at once, when the order is placed.
  const ids = cart.lines.map((l) => l.productId).sort().join(',');
  const stocks = useAsync(() => loadStocks(ids ? ids.split(',') : []), [ids]);
  const stockOf = (productId: string) => stocks.data?.[productId];
  const inventoryUnknown = cart.lines.length > 0 && cart.lines.every((l) => stockOf(l.productId) === null);

  const fixCart = () => {
    for (const s of shortages) {
      if (s.available <= 0) cart.remove(s.productId);
      else cart.setQuantity(s.productId, s.available);
    }
    setShortages([]);
    setError(undefined);
    stocks.reload();
    toast('Cart updated to what is in stock.');
  };

  const placeOrder = async () => {
    setBusy(true);
    setError(undefined);
    setRemovedNames([]);
    setShortages([]);
    try {
      const order = await ordersApi.create(cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })));
      cart.clear();
      notificationsChanged();
      toast('Order placed. We’ll keep you posted.');
      navigate(`/orders/${order.id}`, { state: { justPlaced: true } });
    } catch (err) {
      // 422 with missingProductIds: products deleted since they were added. Drop them and explain.
      const missing = err instanceof ApiError ? (err.problem.missingProductIds as string[] | undefined) : undefined;
      // 409 with shortages: the inventory service refused the whole order (all or nothing). Nothing was reserved.
      const short = shortagesOf(err);
      if (missing?.length) {
        setRemovedNames(cart.lines.filter((l) => missing.includes(l.productId)).map((l) => l.name));
        missing.forEach((id) => cart.remove(id));
      } else if (short) {
        setShortages(short);
        stocks.reload();
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  if (cart.lines.length === 0 && removedNames.length === 0) {
    return (
      <main className="main">
        <PageHeader title="Cart." />
        <EmptyState
          icon="bag"
          title="Your cart is empty."
          action={
            <Link to="/products" className="btn btn-primary">
              Browse the shop
            </Link>
          }
        >
          Add products from the shop, then place your order here.
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="main">
      <PageHeader title="Cart." lead={`${cart.count} ${cart.count === 1 ? 'item' : 'items'} ready to order.`} />

      <div className="two-col">
        <section className="card" aria-label="Cart items">
          {removedNames.length > 0 && (
            <div style={{ marginBottom: 'var(--space-md)' }}>
              <Notice tone="error" icon="alert" title="Some products are no longer available.">
                We removed {removedNames.join(', ')} from your cart. Check the rest and place your order again.
              </Notice>
            </div>
          )}
          {inventoryUnknown && (
            <div style={{ marginBottom: 'var(--space-md)' }}>
              <Notice icon="info" title="We can’t check the stock right now.">
                The inventory service isn’t answering. You can try to place the order; if it is still down, you’ll get a clear
                message and your cart stays as it is.
              </Notice>
            </div>
          )}
          <ul className="list">
            {cart.lines.map((line) => {
              const stock = stockOf(line.productId);
              const tooMany = typeof stock === 'number' && line.quantity > stock;
              return (
                <li key={line.productId} className="list-row wrap">
                  <img className="thumb" src={line.imageUrl} alt="" />
                  <div className="stack gap-xxs grow" style={{ minWidth: 160 }}>
                    <Link to={`/products/${line.productId}`} className="strong" style={{ textDecoration: 'none' }}>
                      {line.name}
                    </Link>
                    <span className="body-sm muted tabular">
                      {formatMoney(line.price)} each · <span style={{ textTransform: 'capitalize' }}>{line.category}</span>
                    </span>
                    {tooMany && (
                      <span className="row gap-xs wrap">
                        <StockBadge stock={stock} />
                        {stock > 0 && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => cart.setQuantity(line.productId, stock)}>
                            Order {stock} instead
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                  <Stepper
                    value={line.quantity}
                    onChange={(q) => cart.setQuantity(line.productId, q)}
                    label={`Quantity of ${line.name}`}
                    max={typeof stock === 'number' ? Math.max(line.quantity, Math.min(MAX_QUANTITY, stock)) : undefined}
                  />
                <span className="strong tabular" style={{ minWidth: 88, textAlign: 'right' }}>
                  {formatMoney(line.price * line.quantity)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => cart.remove(line.productId)}
                  aria-label={`Remove ${line.name}`}
                  title="Remove"
                >
                  <Icon name="x" size={16} />
                </button>
              </li>
              );
            })}
          </ul>
        </section>

        <aside className="card-soft stack gap-lg sticky-aside" aria-label="Order summary">
          <h2 className="h4">Summary.</h2>
          <div className="stack gap-sm">
            <div className="summary-row">
              <span className="muted">Items</span>
              <span className="tabular">{cart.count}</span>
            </div>
            <div className="summary-row">
              <span className="muted">Products</span>
              <span className="tabular">{cart.lines.length}</span>
            </div>
          </div>
          <hr className="divider" style={{ background: 'var(--color-hairline)' }} />
          <div className="summary-total">
            <span>Total</span>
            <span className="tabular">{formatMoney(cart.subtotal)}</span>
          </div>
          {shortages.length > 0 && (
            <Notice tone="error" icon="alert" title="Not enough stock. Your order was not placed.">
              <div className="stack gap-xs">
                <span>Nothing was reserved: an order is reserved all at once or not at all.</span>
                <ul className="list stack gap-xxs">
                  {shortages.map((s) => (
                    <li key={s.productId}>
                      <span className="strong">{s.productName}</span>: you asked for {s.requested},{' '}
                      {s.available > 0 ? `only ${s.available} left.` : 'none left.'}
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }} onClick={fixCart}>
                  Update my cart to what is in stock
                </button>
              </div>
            </Notice>
          )}
          {isInventoryDown(error) ? (
            <Notice tone="error" icon="alert" title="We can’t check the stock right now.">
              The inventory service isn’t answering, so your order was not placed. Your cart is kept: try again in a moment.
            </Notice>
          ) : (
            error != null && <ProblemNotice error={error} />
          )}
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={placeOrder} disabled={busy || cart.lines.length === 0}>
            {busy ? 'Placing order…' : error != null ? 'Try again' : 'Place order'}
          </button>
          <p className="caption muted">
            The final total is calculated by the server from the current prices, so it can never be changed from the browser.
          </p>
        </aside>
      </div>
    </main>
  );
}
