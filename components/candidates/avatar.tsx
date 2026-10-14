'use client';
// Portraits and logos are SVGs in public/ (made by scripts/gen-dataset.ts), so plain <img>
// (next/image rejects SVG). A failed load falls back to initials or a letter tile, never a
// broken-image icon.
import { useState } from 'react';
import { cn } from '@/components/ui/cn';

const TONES = ['bg-indigo-100 text-indigo-800', 'bg-emerald-100 text-emerald-800', 'bg-amber-100 text-amber-900', 'bg-sky-100 text-sky-800', 'bg-rose-100 text-rose-800', 'bg-stone-200 text-stone-700'];
const tone = (s: string) => TONES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export function Avatar({ src, name, size = 48, className }: { src: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (failed || !src) {
    return (
      <span aria-hidden style={style} className={cn('grid shrink-0 place-items-center rounded-full font-semibold', tone(name), className)}>
        {initials(name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- SVG portraits; next/image rejects SVG
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={style}
      className={cn('shrink-0 rounded-full bg-stone-100 object-cover ring-1 ring-black/5', className)}
    />
  );
}

export function CompanyLogo({ src, name, size = 16, className }: { src: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.55) };
  const radius = size >= 32 ? 'rounded-lg' : 'rounded-[4px]';
  if (failed || !src) {
    return (
      <span aria-hidden style={style} className={cn('grid shrink-0 place-items-center bg-stone-200 font-semibold text-stone-600', radius, className)}>
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- SVG logos; next/image rejects SVG
    <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} style={style} className={cn('shrink-0 bg-white object-contain', radius, className)} />
  );
}
