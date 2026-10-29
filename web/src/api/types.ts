// Shapes returned by the API (/api/v1). They mirror the C# DTOs in app/Shop.Api/Modules/*/Dtos.

export type Role = 'Customer' | 'Admin';

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresAtUtc: string;
  role: Role;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  imageUrl: string;
  createdAt: string;
}

export const ORDER_STATUSES = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderItem {
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  statusHistory: { status: OrderStatus; changedAt: string }[];
}

export interface OrderSummary {
  id: string;
  userId: string;
  status: OrderStatus;
  totalAmount: number;
  itemCount: number;
  createdAt: string;
}

export interface Notification {
  id: string;
  message: string;
  orderId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** RFC 9457 Problem Details: the API's single error format. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: Record<string, string[]>;
  [extension: string]: unknown;
}
