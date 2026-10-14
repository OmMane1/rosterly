import { Bookmark, Search, Star, type LucideIcon } from 'lucide-react';

export type NavItem = { href: string; label: string; icon: LucideIcon; match: (path: string) => boolean };

export const NAV: NavItem[] = [
  { href: '/', label: 'Search', icon: Search, match: (p) => p === '/' || p.startsWith('/people') },
  { href: '/shortlists', label: 'Shortlists', icon: Bookmark, match: (p) => p.startsWith('/shortlists') },
  { href: '/saved', label: 'Saved', icon: Star, match: (p) => p.startsWith('/saved') },
];
