import { api } from './client';
import type { LoginResponse, Notification, Order, OrderStatus, OrderSummary, Paged, Product, User } from './types';

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== false) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const authApi = {
  register: (email: string, password: string) => api<User>('/auth/register', { method: 'POST', body: { email, password } }),
  login: (email: string, password: string) =>
    api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password }, token: null }),
  me: (token?: string) => api<User>('/auth/me', token ? { token } : {}),
};

export const usersApi = {
  list: () => api<User[]>('/users'),
};

export const productsApi = {
  list: (params: { category?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
    api<Paged<Product>>(`/products${query(params)}`, { signal, token: null }),
  get: (id: string) => api<Product>(`/products/${id}`, { token: null }),
  create: (form: FormData) => api<Product>('/products', { method: 'POST', form }),
};

export const ordersApi = {
  create: (items: { productId: string; quantity: number }[]) => api<Order>('/orders', { method: 'POST', body: { items } }),
  list: (params: { status?: OrderStatus; page?: number; pageSize?: number }) =>
    api<Paged<OrderSummary>>(`/orders${query(params)}`),
  get: (id: string) => api<Order>(`/orders/${id}`),
  changeStatus: (id: string, status: OrderStatus) => api<Order>(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),
};

export const notificationsApi = {
  list: (params: { unreadOnly?: boolean; page?: number; pageSize?: number }) =>
    api<Paged<Notification>>(`/notifications${query(params)}`),
  unreadCount: () => api<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string) => api<void>(`/notifications/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => api<void>('/notifications/read-all', { method: 'POST' }),
};

/** Product images are served by the API; imageUrl is already "/api/v1/products/{id}/image". */
export const imageSrc = (product: Pick<Product, 'imageUrl'>) => product.imageUrl;
