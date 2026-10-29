import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { productsApi, usersApi } from '../api/endpoints';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { EmptyState, PageHeader, ProblemNotice, TextAreaField, TextField } from '../components/ui';
import { capitalize, formatDate, shortId } from '../lib/format';
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
      toast(`${product.name} is now in the shop.`);
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
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add product'}
          </button>
        </div>
      </form>
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
