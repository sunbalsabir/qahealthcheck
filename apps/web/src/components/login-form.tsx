'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button, Field, inputClass } from './ui';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error ?? 'Sign in failed. Please try again.');
        setSubmitting(false);
        return;
      }

      router.push('/admin');
      router.refresh();
    } catch {
      setError('We could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Email" htmlFor="email" required>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className={inputClass}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
      </Field>

      <Field label="Password" htmlFor="password" required>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-600">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Signing in…
          </>
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}
