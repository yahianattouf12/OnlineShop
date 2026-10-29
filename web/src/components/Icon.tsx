// A small set of line icons (24px grid, 2px stroke), drawn in currentColor so they follow the monochrome text.
const paths = {
  bag: 'M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z M9 8V7a3 3 0 0 1 6 0v1',
  bell: 'M6 9a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8 M10.3 21a1.94 1.94 0 0 0 3.4 0',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8Z M3 8l9 5 9-5 M12 13v8',
  check: 'm5 12 5 5L20 7',
  chevronLeft: 'm15 18-6-6 6-6',
  chevronRight: 'm9 18 6-6-6-6',
  arrowRight: 'M5 12h14 M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5 M11 18l-6-6 6-6',
  x: 'M18 6 6 18 M6 6l12 12',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  alert: 'M12 8v5 M12 16.5v.5 M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-5 M12 8v.5 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 2-2 5 5 M15.5 9.5h.01',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z M9 12l2 2 4-4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  receipt: 'M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5 5 3Z M9 9h6 M9 13h6',
  play: 'M7 4v16l13-8L7 4Z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}
