import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/theme-toggle';

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground relative isolate min-h-screen overflow-hidden">
      <div className="bg-grain pointer-events-none absolute inset-0 -z-10" />
      <div className="from-foreground/4 pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-gradient-to-b to-transparent" />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link
          to="/"
          className="group flex items-baseline gap-1.5 text-sm tracking-tight"
        >
          <span className="font-display text-base leading-none italic">
            hono
          </span>
          <span className="text-muted-foreground/70 leading-none">·</span>
          <span className="text-muted-foreground leading-none lowercase">
            mono
          </span>
        </Link>
        <ThemeToggle />
      </header>

      <main className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-24 sm:px-8">
        <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards space-y-8 duration-500">
          {children}
        </div>
      </main>
    </div>
  );
}
