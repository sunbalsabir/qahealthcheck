'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LEAD_FOLLOW_UP_STATUSES, type LeadFollowUpStatus } from '@qualovix/shared';

const LABELS: Record<LeadFollowUpStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  CONVERTED: 'Converted',
  NOT_INTERESTED: 'Not interested',
};

export function LeadStatusSelect({
  leadId,
  status,
}: {
  leadId: string;
  status: LeadFollowUpStatus;
}) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);

  async function change(next: LeadFollowUpStatus) {
    const previous = value;
    setValue(next);
    setSaving(true);

    const response = await fetch(`/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ followUpStatus: next }),
    });

    if (!response.ok) {
      // Roll back so the UI never claims a change that did not persist.
      setValue(previous);
    } else {
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <>
      <label htmlFor={`status-${leadId}`} className="sr-only">
        Follow-up status
      </label>
      <select
        id={`status-${leadId}`}
        value={value}
        disabled={saving}
        onChange={(event) => change(event.target.value as LeadFollowUpStatus)}
        className="rounded-lg border-0 py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600 disabled:opacity-50"
      >
        {LEAD_FOLLOW_UP_STATUSES.map((option) => (
          <option key={option} value={option}>
            {LABELS[option]}
          </option>
        ))}
      </select>
    </>
  );
}
