'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/admin/login');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      <LogOut className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">Sign out</span>
    </button>
  );
}
