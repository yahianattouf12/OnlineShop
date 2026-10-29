import type { OrderStatus } from '../api/types';

/**
 * The order life cycle, mirrored from OrderStatusRules on the server so the UI only offers valid moves.
 * The server still enforces it: anything else returns 422.
 */
export const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  Pending: ['Confirmed', 'Cancelled'],
  Confirmed: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};

/** The normal path, used to draw the timeline's upcoming steps. */
export const HAPPY_PATH: OrderStatus[] = ['Pending', 'Confirmed', 'Shipped', 'Delivered'];

export const STATUS_HELP: Record<OrderStatus, string> = {
  Pending: 'Received, waiting for confirmation.',
  Confirmed: 'Confirmed and being prepared.',
  Shipped: 'On its way.',
  Delivered: 'Delivered.',
  Cancelled: 'Cancelled.',
};

export const STATUS_ACTION: Record<OrderStatus, string> = {
  Pending: 'Mark as pending',
  Confirmed: 'Confirm order',
  Shipped: 'Mark as shipped',
  Delivered: 'Mark as delivered',
  Cancelled: 'Cancel order',
};
