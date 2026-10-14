'use client';
import type { ReactNode } from 'react';
import { UpgradeProvider } from '@/components/plan/upgrade';
import { AppHeader } from '@/components/shell/app-header';
import { AuthGate } from '@/components/shell/auth-gate';
import { BottomTabs } from '@/components/shell/bottom-tabs';
import { ShellSkeleton } from '@/components/shell/shell-skeleton';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate fallback={<ShellSkeleton />}>
      <UpgradeProvider>
        <AppHeader />
        <main className="mx-auto w-full max-w-5xl px-4 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 md:pt-10 md:pb-24">{children}</main>
        <BottomTabs />
      </UpgradeProvider>
    </AuthGate>
  );
}
