// Where "back" goes. Results remember their scroll position when a recruiter opens a candidate, so
// going back (our Back button or the browser's) lands on the same page at the same spot.
const RETURN_KEY = 'rosterly:return';

type Return = { key: string; y: number };

const read = (): Return | null => {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null');
    return v && typeof v === 'object' && 'key' in v && 'y' in v && typeof v.key === 'string' && typeof v.y === 'number' ? { key: v.key, y: v.y } : null;
  } catch {
    return null;
  }
};

/** Called when a result is opened. */
export function rememberScroll(key: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ key, y: window.scrollY }));
  } catch {
    // private mode or storage blocked: back still works, it just starts at the top
  }
}

/** The remembered position for this results page, once; null if it belongs to another page. */
export function takeScroll(key: string): number | null {
  const saved = read();
  if (!saved || saved.key !== key) return null;
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // ignore
  }
  return saved.y;
}

// The in-app page before this one, so Back can use history (which keeps scroll and doesn't add an
// entry) only when history really leads where its label says.
let current: string | null = null;
let previous: string | null = null;
export const trackNavigation = (url: string) => {
  if (url === current) return;
  previous = current;
  current = url;
};

const normalise = (url: string) => {
  const u = new URL(url, 'http://x');
  u.searchParams.sort();
  return `${u.pathname}?${u.searchParams.toString()}`;
};

/** True when the previous in-app page is `href`, so history back lands there. */
export const cameFrom = (href: string) => previous !== null && normalise(previous) === normalise(href);
