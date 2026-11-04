import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Product } from '../api/types';

export interface CartLine {
  productId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: string;
  quantity: number;
}

// The API's limits for one order (CreateOrderRequest): up to 20 different products, 1–100 of each.
export const MAX_LINES = 20;
export const MAX_QUANTITY = 100;

interface CartState {
  lines: CartLine[];
  count: number;
  subtotal: number;
  /** Returns false if the cart already holds the maximum number of different products. */
  add: (product: Product, quantity: number) => boolean;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

const STORAGE_KEY = 'onlineshop.cart';
const CartContext = createContext<CartState | null>(null);

function readCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
}

const clamp = (n: number) => Math.min(MAX_QUANTITY, Math.max(1, Math.round(n)));

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(readCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // The cart still works for this visit without storage.
    }
  }, [lines]);

  const add = useCallback(
    (product: Product, quantity: number) => {
      if (!lines.some((l) => l.productId === product.id) && lines.length >= MAX_LINES) return false;
      setLines((current) => {
        if (current.some((l) => l.productId === product.id)) {
          return current.map((l) => (l.productId === product.id ? { ...l, quantity: clamp(l.quantity + quantity) } : l));
        }
        return [
          ...current,
          {
            productId: product.id,
            name: product.name,
            price: product.price,
            imageUrl: product.imageUrl,
            category: product.category,
            quantity: clamp(quantity),
          },
        ];
      });
      return true;
    },
    [lines],
  );

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setLines((current) => current.map((l) => (l.productId === productId ? { ...l, quantity: clamp(quantity) } : l)));
  }, []);

  const remove = useCallback((productId: string) => {
    setLines((current) => current.filter((l) => l.productId !== productId));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartState>(
    () => ({
      lines,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotal: lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
      add,
      setQuantity,
      remove,
      clear,
    }),
    [lines, add, setQuantity, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
