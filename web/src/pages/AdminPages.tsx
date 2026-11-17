import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { productsApi, usersApi } from '../api/endpoints';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import {
  EmptyState,
  Notice,
  PageHeader,
  Pagination,
  ProblemNotice,
  Spinner,
  StockBadge,
  StockEditor,
  TextAreaField,
  TextField,
} from '../components/ui';
import { capitalize, formatDate, formatMoney, shortId } from '../lib/format';
import { loadStocks } from '../lib/stock';
import { useAsync } from '../lib/useAsync';

// Same limits as the API (ImageFileAttribute). The server re-checks everything, including the file's real bytes.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = '.jpg,.jpeg,.png,.webp';

export function AddProductPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [stock, setStock] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>();
  const [imageError, setImageError] = useState<string[]>();
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const existing = useAsync(() => productsApi.list({ pageSize: 50 }), []);
  const categories = useMemo(() => [...new Set((existing.data?.items ?? []).map((p) => p.category))].sort(), [existing.data]);

  useEffect(() => {
    if (!image) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  const pickImage = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(['The image must be at most 5 MB.']);
      return;
    }
    setImageError(undefined);
    setImage(file);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const form = new FormData();
    form.set('name', name);
    form.set('category', category);
    // Empty fields are left out instead of sent as "": the API treats an empty description as missing
    // (non-nullable string) and an empty price as "not a number", while leaving them out gives the
    // optional description and the clearer "must be between 0.01 and 1,000,000" price message.
    if (price.trim()) form.set('price', price);
    if (description.trim()) form.set('description', description);
    if (image) form.set('image', image);
    try {
      const product = await productsApi.create(form);
      // The stock is not part of the product: it lives in the inventory service, so it is a second call.
      // If that one fails (e.g. the inventory service is down), the product still exists; say so clearly.
      const units = Number(stock);
      if (stock.trim() && units > 0) {
        try {
          await productsApi.setStock(product.id, units);
          toast(`${product.name} is now in the shop, with ${units} in stock.`);
        } catch {
          toast(`${product.name} was added, but its stock could not be set. Set it on the product page.`);
        }
      } else {
        toast(`${product.name} is now in the shop. Set its stock so customers can order it.`);
      }
      navigate(`/products/${product.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError && error.status === 422 ? error : undefined;
  const errorsFor = (field: string) => apiError?.fieldErrors(field);
  const imageErrors = imageError ?? errorsFor('Image');
  const stockUnits = Number(stock);
  const stockError =
    stock.trim() && !(Number.isInteger(stockUnits) && stockUnits >= 0 && stockUnits <= 1_000_000)
      ? ['A whole number from 0 to 1,000,000.']
      : undefined;

  return (
    <main className="main main-medium">
      <PageHeader title="Add a product." lead="It appears in the shop right away, newest first." />

      <form className="card stack gap-xl" onSubmit={submit} noValidate>
        {error != null && !apiError && <ProblemNotice error={error} />}
        {apiError && (
          <ProblemNotice error={new ApiError(422, { ...apiError.problem, title: 'Some fields need attention.', detail: undefined }, null)} />
        )}

        <div className="form-grid">
          <div className={`field ${imageErrors?.length ? 'field-invalid' : ''}`}>
            <span className="field-label" id="image-label">
              Image
            </span>
            <label
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickImage(e.dataTransfer.files[0]);
              }}
            >
              <input type="file" accept={IMAGE_TYPES} aria-labelledby="image-label" onChange={(e) => pickImage(e.target.files?.[0])} />
              {preview ? (
                <img src={preview} alt="Preview of the selected image" />
              ) : (
                <span className="stack gap-xs" style={{ alignItems: 'center', textAlign: 'center', padding: 'var(--space-md)' }}>
                  <span className="squircle squircle-soft">
                    <Icon name="upload" />
                  </span>
                  <span className="strong">Drop an image or browse</span>
                  <span className="caption muted">JPG, PNG or WebP · up to 5 MB</span>
                </span>
              )}
            </label>
            {imageErrors?.length ? (
              <div className="field-error">
                <Icon name="alert" size={14} />
                <span>{imageErrors.join(' ')}</span>
              </div>
            ) : (
              image && (
                <div className="row between gap-sm">
                  <span className="caption muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {image.name}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImage(null)}>
                    Remove
                  </button>
                </div>
              )
            )}
          </div>

          <div className="stack gap-lg">
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errorsFor('Name')} maxLength={200} placeholder="Phone X" />
            <TextField
              label="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              error={errorsFor('Category')}
              maxLength={50}
              list="categories"
              placeholder="phones"
              hint="Pick an existing one or type a new one."
            />
            <datalist id="categories">
              {categories.map((c) => (
                <option key={c} value={c}>
                  {capitalize(c)}
                </option>
              ))}
            </datalist>
            <TextField
              label="Price (USD)"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              error={errorsFor('Price')}
              placeholder="199.99"
            />
            <TextField
              label="Units in stock"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              error={stockError}
              placeholder="0"
              hint="Optional. Sent to the inventory service after the product is created."
            />
          </div>

          <TextAreaField
            className="span-2"
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            error={errorsFor('Description')}
            maxLength={2000}
            placeholder="A short description customers will see on the product page."
            hint="Optional · up to 2,000 characters."
          />
        </div>

        <div className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/products')}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || stockError != null}>
            {busy ? 'Adding…' : 'Add product'}
          </button>
        </div>
      </form>
    </main>
  );
}

/**
 * Inventory management (Requirement 2). The stock is not in this app's database: every number here is asked
 * from the inventory service over gRPC (GetStock), and every save is sent to it (SetStock).
 */
export function InventoryPage() {
  const [page, setPage] = useState(1);
  const products = useAsync(() => productsApi.list({ page, pageSize: 12 }), [page]);
  const ids = (products.data?.items ?? []).map((p) => p.id).join(',');
  const stocks = useAsync(() => loadStocks(ids ? ids.split(',') : []), [ids]);
  const toast = useToast();

  const items = products.data?.items ?? [];
  const stocksReady = !stocks.loading && stocks.data != null;
  const inventoryDown = stocksReady && items.length > 0 && items.every((p) => stocks.data![p.id] === null);

  return (
    <main className="main">
      <PageHeader
        title="Inventory."
        lead="Stock lives in the inventory service, with its own database. This page asks it, and sends it your changes."
        actions={
          <>
            <button type="button" className="btn btn-soft" onClick={stocks.reload} disabled={stocks.loading}>
              Refresh stock
            </button>
            <Link to="/admin/products/new" className="btn btn-primary">
              <Icon name="plus" size={16} />
              Add product
            </Link>
          </>
        }
      />

      {inventoryDown && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <Notice tone="error" icon="alert" title="The inventory service isn’t answering.">
            The stock can’t be read or changed until it’s back. The shop still works, without stock. To bring it back:{' '}
            <span className="mono">docker compose start inventory</span>
          </Notice>
        </div>
      )}

      {products.error ? (
        <ProblemNotice error={products.error} />
      ) : !products.data ? (
        <div className="skeleton" style={{ height: 320 }} />
      ) : items.length === 0 ? (
        <EmptyState icon="box" title="No products yet." action={<Link to="/admin/products/new" className="btn btn-primary">Add a product</Link>}>
          Add products first, then set their stock here.
        </EmptyState>
      ) : (
        <>
          <div className="card table-wrap" style={{ padding: 'var(--space-md) var(--space-sm) var(--space-xs)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="num">Price</th>
                  <th>Stock</th>
                  <th>Set stock</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const stock = stocks.data?.[p.id];
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/products/${p.id}`} className="row gap-sm strong" style={{ textDecoration: 'none', color: 'inherit' }}>
                          <img className="thumb" src={p.imageUrl} alt="" />
                          {p.name}
                        </Link>
                      </td>
                      <td className="muted">{capitalize(p.category)}</td>
                      <td className="num">{formatMoney(p.price)}</td>
                      <td>{stocksReady ? <StockBadge stock={stock} /> : <Spinner label="Asking" />}</td>
                      <td style={{ minWidth: 220 }}>
                        <StockEditor
                          compact
                          productId={p.id}
                          productName={p.name}
                          stock={stocksReady ? stock : undefined}
                          onSaved={(saved) => {
                            stocks.setData({ ...stocks.data, [p.id]: saved });
                            toast(`${p.name}: ${saved} in stock.`);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={products.data.totalPages} onChange={setPage} />
        </>
      )}
    </main>
  );
}

export function UsersPage() {
  const users = useAsync(() => usersApi.list(), []);
  const data = users.data;

  return (
    <main className="main">
      <PageHeader title="Users." lead={data ? `${data.length} accounts. Only the admin can see this list.` : 'Only the admin can see this list.'} />
      {users.error ? (
        <ProblemNotice error={users.error} />
      ) : !data ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : data.length === 0 ? (
        <EmptyState icon="users" title="No users yet." />
      ) : (
        <div className="card table-wrap" style={{ padding: 'var(--space-md) var(--space-sm) var(--space-xs)' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
                <th>Id</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((u) => (
                <tr key={u.id}>
                  <td className="strong">{u.email}</td>
                  <td>
                    <span className={`badge ${u.role === 'Admin' ? 'badge-ink' : 'badge-soft'}`}>{u.role}</span>
                  </td>
                  <td className="muted">{formatDate(u.createdAt)}</td>
                  <td className="mono muted" title={u.id}>
                    {shortId(u.id)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
