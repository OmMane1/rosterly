'use client';
// Signed-in pages render only with a session. Auth happens in the API routes (CLAUDE.md: no
// middleware), so this gate is about where to send the recruiter, not about protecting data.
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/client/supabase';

export function AuthGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const auth = supabase().auth;
    let active = true;
    void auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) setSignedIn(true);
      else router.replace(`/login?next=${encodeURIComponent(pathname + window.location.search)}`);
    });
    const { data } = auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT') return;
      // Nothing of one company's data may outlive its session in this tab.
      qc.clear();
      router.replace('/login');
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
    // Runs once per mount: later navigations keep the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return signedIn ? children : fallback;
}
