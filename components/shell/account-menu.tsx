'use client';
import { LogOut, UserRound } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { supabase } from '@/lib/client/supabase';

export function AccountMenu({ email, company }: { email: string | null; company: string | null }) {
  return (
    <Menu>
      <MenuTrigger
        aria-label="Account"
        className="grid size-9 place-items-center rounded-full bg-white text-stone-600 ring-1 ring-stone-300 ring-inset hover:bg-stone-50 hover:text-ink data-[state=open]:bg-stone-100"
      >
        <UserRound className="size-4" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel className="px-3 pt-2 pb-2.5">
          <p className="truncate text-sm font-medium">{email ?? 'Signed in'}</p>
          {company && <p className="text-xs text-stone-500">Recruiter at {company}</p>}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => void supabase().auth.signOut({ scope: 'local' })}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
