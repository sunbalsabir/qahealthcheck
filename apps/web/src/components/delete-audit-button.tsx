'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';

/**
 * Deleting an audit removes the findings, the lead association and the
 * report history, so the button asks for explicit confirmation naming the
 * site rather than firing on a single click.
 */
export function DeleteAuditButton({ auditId, domain }: { auditId: string; domain: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    const response = await fetch(`/api/audits/${auditId}`, { method: 'DELETE' });
    if (response.ok) {
      router.push('/admin');
      router.refresh();
      return;
    }
    setDeleting(false);
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-500 hover:bg-red-50 hover:text-red-700"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Delete
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 ring-1 ring-inset ring-red-200">
      <span className="text-xs font-medium text-red-900">Delete the {domain} audit?</span>
      <button
        type="button"
        onClick={remove}
        disabled={deleting}
        className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:bg-red-300"
      >
        {deleting ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Yes, delete
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={deleting}
        className="rounded px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
      >
        Cancel
      </button>
    </div>
  );
}
