import { Icon } from '@iconify/react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { authClient } from '../lib/auth-client';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? 'Sign in failed');
      } else {
        await navigate({ to: '/' });
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleGitHub() {
    await authClient.signIn.social({
      provider: 'github',
      callbackURL: import.meta.env.VITE_APP_URL ?? window.location.origin,
    });
  }

  return (
    <>
      <header className="space-y-2.5">
        <h1 className="font-display text-4xl leading-[1.05] tracking-tight">
          Welcome <span className="italic">back</span>.
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Sign in to continue to your workspace.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
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
            className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.16em] uppercase"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="border-foreground/15 focus:border-foreground w-full border-0 border-b bg-transparent py-2 text-base transition-colors focus:ring-0 focus:outline-none"
          />
        </div>
        {error && (
          <p className="text-destructive animate-in fade-in slide-in-from-top-1 text-sm duration-200">
            {error}
          </p>
        )}
        <Button type="submit" disabled={loading} className="h-11 w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="relative flex items-center gap-3">
        <span className="bg-foreground/10 h-px flex-1" />
        <span className="text-muted-foreground text-[0.7rem] tracking-[0.16em] uppercase">
          or
        </span>
        <span className="bg-foreground/10 h-px flex-1" />
      </div>

      <Button
        variant="outline"
        onClick={handleGitHub}
        className="h-11 w-full gap-2"
      >
        <Icon icon="logos:github-icon" className="size-4" />
        Continue with GitHub
      </Button>

      <p className="text-muted-foreground text-center text-xs">
        New here?{' '}
        <Link
          to="/register"
          className="text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
        >
          Create an account
        </Link>
      </p>
    </>
  );
}
