'use client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { isApiError } from '@/lib/client/api';
import { trackNavigation } from '@/lib/client/navigation';
import { supabase } from '@/lib/client/supabase';

// An expired or revoked session anywhere means "sign in again"; the auth gate hears SIGNED_OUT.
const signOutOn401 = (err: unknown) => {
  if (isApiError(err, 401)) void supabase().auth.signOut({ scope: 'local' });
};

function makeClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: signOutOn401 }),
    mutationCache: new MutationCache({ onError: signOutOn401 }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // A 4xx won't fix itself; a network blip or 5xx gets one more try before the error state.
        retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 1,
      },
      mutations: { retry: false },
    },
  });
}

function NavigationTracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => trackNavigation(search ? `${pathname}?${search}` : pathname), [pathname, search]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Suspense fallback={null}>
          <NavigationTracker />
        </Suspense>
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
