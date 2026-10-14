'use client';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cameFrom } from '@/lib/client/navigation';

/**
 * A real link to `href`. When the previous in-app page is `href`, it goes back in history instead,
 * so results come back at the same page and scroll position without a second history entry.
 */
export function BackButton({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2.5 h-10 text-stone-800 sm:h-9">
      <Link
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || !cameFrom(href)) return;
          e.preventDefault();
          router.back();
        }}
      >
        <ArrowLeft /> {label}
      </Link>
    </Button>
  );
}
