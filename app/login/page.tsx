'use client';
// Sign-in (Supabase email/password through the same-origin /supabase rewrite). The seeded demo
// accounts are one tap away: the buttons fill the form, and Sign in does the rest.
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Building2 } from 'lucide-react';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Logo } from '@/components/shell/logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { supabase } from '@/lib/client/supabase';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/lib/shared/demo-accounts';

export default function LoginRoute() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

/** Only our own paths, so ?next= can't send anyone to another site. */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');

function Login() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  // Already signed in: straight to the app.
  useEffect(() => {
    void supabase()
      .auth.getSession()
      .then(({ data }) => data.session && router.replace(next));
  }, [router, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your email and password, or use a demo account below.');
    setError(null);
    setPending(true);
    try {
      const { error: err } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
      if (err) {
        setError(err.status === 400 ? 'That email and password don’t match an account.' : 'Couldn’t sign in right now. Try again in a moment.');
        return;
      }
      qc.clear(); // nothing cached for another account survives a sign-in
      router.replace(next);
    } catch {
      setError('Couldn’t reach the sign-in service. Check that the app is running, then try again.');
    } finally {
      setPending(false);
    }
  };

  const fill = (accountEmail: string) => {
    setEmail(accountEmail);
    setPassword(DEMO_PASSWORD);
    setError(null);
    submitRef.current?.focus();
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2">
          <Logo className="size-8" />
          <span className="text-lg font-semibold tracking-tight">Rosterly</span>
        </div>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-[15px] text-stone-600">Find candidates by describing them in plain English.</p>

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="text-sm font-medium">
              Work email
            </label>
            <Input id="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1.5" />
          </div>
          <div>
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="mt-1.5" />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200 ring-inset">
              {error}
            </p>
          )}
          <Button ref={submitRef} type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? <Spinner /> : null}
            {pending ? 'Signing in' : 'Sign in'}
            {!pending && <ArrowRight />}
          </Button>
        </form>

        <section aria-labelledby="demo-accounts" className="mt-8 border-t border-stone-200 pt-6">
          <h2 id="demo-accounts" className="text-sm font-medium">
            Demo accounts
          </h2>
          <p className="mt-0.5 text-[13px] text-stone-500">Fills in the email and password. Each company sees only its own lists and searches.</p>
          <div className="mt-3 grid gap-2">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.slug}
                type="button"
                onClick={() => fill(a.email)}
                aria-label={`Use the ${a.name} demo account`}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl bg-white p-3 text-left ring-1 ring-stone-200 transition ring-inset hover:ring-stone-400',
                  email === a.email && 'bg-indigo-50/60 ring-2 ring-indigo-500',
                )}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-600">
                  <Building2 aria-hidden className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{a.name}</span>
                  <span className="block truncate text-xs text-stone-500">{a.email}</span>
                </span>
                <span aria-hidden className="text-xs font-medium text-stone-500">
                  {email === a.email ? 'Filled in' : 'Use'}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
