import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';

import { authClient } from '../lib/auth-client';

export function AppLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();

  async function handleSignOut() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-foreground/8 bg-background/75 sticky top-0 z-20 border-b backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5 sm:px-8">
          <Link
            to="/"
            className="flex items-baseline gap-1.5 text-base tracking-tight"
          >
            <span className="font-display text-lg leading-none italic">
              hono
            </span>
            <span className="text-muted-foreground/70 leading-none">·</span>
            <span className="text-muted-foreground leading-none lowercase">
              mono
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              to="/chat"
              className="text-muted-foreground hover:text-foreground [&.active]:text-foreground transition-colors"
            >
              Chat
            </Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            {session?.user && (
              <span className="text-muted-foreground hidden text-xs sm:inline">
                {session.user.email}
              </span>
            )}
            <ThemeToggle />
            {session?.user && (
              <Button variant="outline" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10 sm:px-8 sm:py-14">
        <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
