import { Icon } from '@iconify/react';
import { useState } from 'react';

type Theme = 'light' | 'dark';

function readInitialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* ignore quota / privacy mode */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
      }
      className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground inline-flex size-8 items-center justify-center rounded-md transition-colors"
    >
      <Icon
        icon={theme === 'dark' ? 'solar:sun-2-linear' : 'solar:moon-linear'}
        className="size-4"
      />
    </button>
  );
}
