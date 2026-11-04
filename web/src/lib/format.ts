const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

export const formatMoney = (value: number) => money.format(value);
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatDate = (iso: string) => date.format(new Date(iso));

/** "6a8271b2": the same short id the API puts in notification messages. */
export const shortId = (id: string) => id.slice(0, 8);

export function timeAgo(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(iso);
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
