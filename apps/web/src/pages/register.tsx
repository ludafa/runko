import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { authClient } from '../lib/auth-client';

export function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await authClient.signUp.email({ name, email, password });
      if (result.error) {
        setError(result.error.message ?? 'Sign up failed');
      } else {
        await navigate({ to: '/' });
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <header className="space-y-2.5">
        <h1 className="font-display text-4xl leading-[1.05] tracking-tight">
          Create your <span className="italic">account</span>.
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Spin up a workspace in under a minute — no credit card.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1.5">
          <label
            htmlFor="name"
            className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.16em] uppercase"
          >
            Name
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="border-foreground/15 focus:border-foreground w-full border-0 border-b bg-transparent py-2 text-base transition-colors focus:ring-0 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="email"
            className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.16em] uppercase"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="border-foreground/15 focus:border-foreground w-full border-0 border-b bg-transparent py-2 text-base transition-colors focus:ring-0 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="password"
            className="text-muted-foreground flex items-baseline justify-between text-[0.7rem] font-medium tracking-[0.16em] uppercase"
          >
            <span>Password</span>
            <span className="text-muted-foreground/70 tracking-normal normal-case">
              min 8 chars
            </span>
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="border-foreground/15 focus:border-foreground w-full border-0 border-b bg-transparent py-2 text-base transition-colors focus:ring-0 focus:outline-none"
          />
        </div>
        {error && (
          <p className="text-destructive animate-in fade-in slide-in-from-top-1 text-sm duration-200">
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} className="h-11 w-full">
          {loading ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p className="text-muted-foreground text-center text-xs">
        Already a member?{' '}
        <Link
          to="/login"
          className="text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
