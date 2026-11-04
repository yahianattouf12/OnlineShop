import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { productsApi } from '../api/endpoints';
import type { Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { EmptyState, PageHeader, Pagination, ProblemNotice, Segmented } from '../components/ui';
import { capitalize, formatMoney } from '../lib/format';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 12;

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link to={`/products/${product.id}`} className="product-card">
      <div className="product-media">
        <img src={product.imageUrl} alt={product.name} loading="lazy" />
        <span className="media-badge">{product.category}</span>
      </div>
      <div className="stack gap-xxs">
        <div className="strong">{product.name}</div>
        <div className="body-sm muted tabular">{formatMoney(product.price)}</div>
      </div>
    </Link>
  );
}

function ProductGridSkeleton() {
  return (
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="stack gap-sm">
          <div className="skeleton" style={{ aspectRatio: '1' }} />
          <div className="skeleton" style={{ height: 16, width: '70%' }} />
          <div className="skeleton" style={{ height: 14, width: '30%' }} />
        </div>
      ))}
    </div>
  );
}

export function ProductsPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // The API has no "list categories" endpoint, so the filter options come from the newest 50 products.
  const categories = useAsync(() => productsApi.list({ pageSize: 50 }), []);
  const categoryOptions = useMemo(() => {
    const names = new Set((categories.data?.items ?? []).map((p) => p.category));
    if (category) names.add(category.toLowerCase());
    return [{ value: '', label: 'All' }, ...[...names].sort().map((c) => ({ value: c, label: capitalize(c) }))];
  }, [categories.data, category]);

  const products = useAsync(() => productsApi.list({ category, page, pageSize: PAGE_SIZE }), [category, page]);

  const update = (next: { category?: string; page?: number }) => {
    const search = new URLSearchParams();
    const c = next.category ?? category;
    const p = next.page ?? 1;
    if (c) search.set('category', c);
    if (p > 1) search.set('page', String(p));
    setParams(search);
  };

  const data = products.data;

  return (
    <main className="main">
      <PageHeader
        title="Shop."
        lead={data ? `${data.totalCount} ${data.totalCount === 1 ? 'product' : 'products'}${category ? ` in ${category}` : ''}, newest first.` : 'Newest first.'}
        actions={
          isAdmin && (
            <Link to="/admin/products/new" className="btn btn-primary">
              <Icon name="plus" size={18} />
              Add product
            </Link>
          )
        }
      />

      {categoryOptions.length > 1 && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <Segmented
            label="Filter by category"
            options={categoryOptions}
            value={category.toLowerCase()}
            onChange={(value) => update({ category: value, page: 1 })}
          />
        </div>
      )}

      {products.error ? (
        <ProblemNotice error={products.error} />
      ) : !data ? (
        <ProductGridSkeleton />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon="box"
          title={category ? 'Nothing in this category yet.' : 'The shop is empty.'}
          action={
            category ? (
              <button type="button" className="btn btn-primary" onClick={() => update({ category: '', page: 1 })}>
                Show all products
              </button>
            ) : (
              isAdmin && (
                <Link to="/admin/products/new" className="btn btn-primary">
                  Add the first product
                </Link>
              )
            )
          }
        >
          {category ? 'Try another category.' : isAdmin ? 'Add a product with its image to get started.' : 'Products added by the admin will show up here.'}
        </EmptyState>
      ) : (
        <>
          <div className="product-grid" style={{ opacity: products.loading ? 0.6 : 1 }}>
            {data.items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
          <Pagination page={data.page} totalPages={data.totalPages} onChange={(p) => update({ page: p })} />
        </>
      )}
    </main>
  );
}
