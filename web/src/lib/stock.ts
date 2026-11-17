import { ApiError } from '../api/client';
import { productsApi } from '../api/endpoints';
import type { StockShortage } from '../api/types';

/** At or below this many units, the shop says "Only N left". */
export const LOW_STOCK = 5;

export type StockLevel = 'unknown' | 'out' | 'low' | 'in';

/** null/undefined: the inventory service could not be asked, so we do not know. */
export function stockLevel(stock: number | null | undefined): StockLevel {
  if (stock == null) return 'unknown';
  if (stock <= 0) return 'out';
  if (stock <= LOW_STOCK) return 'low';
  return 'in';
}

export function stockLabel(stock: number | null | undefined) {
  switch (stockLevel(stock)) {
    case 'unknown':
      return 'Availability unknown';
    case 'out':
      return 'Out of stock';
    case 'low':
      return `Only ${stock} left`;
    default:
      return `${stock} in stock`;
  }
}

/** The 409 "Not enough stock" refusal of POST /orders lists what was short; anything else gives undefined. */
export function shortagesOf(error: unknown): StockShortage[] | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const shortages = error.problem.shortages;
  return Array.isArray(shortages) && shortages.length > 0 ? (shortages as StockShortage[]) : undefined;
}

/** 503: the inventory service is stopped, or did not answer before the app's deadline. */
export const isInventoryDown = (error: unknown) => error instanceof ApiError && error.status === 503;

/**
 * The stock of several products. The list endpoint has no stock, so this asks the details endpoint of each one
 * (the app asks the inventory service for every call). A product that could not be loaded maps to undefined.
 */
export async function loadStocks(ids: string[]): Promise<Record<string, number | null | undefined>> {
  const entries = await Promise.all(
    ids.map((id) =>
      productsApi
        .get(id)
        .then((p) => [id, p.stock ?? null] as const)
        .catch(() => [id, undefined] as const),
    ),
  );
  return Object.fromEntries(entries);
}
