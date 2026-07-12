import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

import { getApiNotes, postApiNotes } from '../gen/clients';
import type { Note } from '../gen/types';

export function DashboardPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    getApiNotes()
      .then(setNotes)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const note = await postApiNotes({ title, body });
    setNotes((prev) => [...prev, note]);
    setTitle('');
    setBody('');
  }

  return (
    <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] md:gap-16">
      <section className="space-y-10">
        <header className="space-y-3">
          <p className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.18em] uppercase">
            Workspace
          </p>
          <h1 className="font-display text-5xl leading-[1.02] tracking-tight">
            <span className="italic">Notes</span>
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
            A throwaway example wired through the full stack: Hono → OpenAPI →
            Kubb → React. Replace it with your domain.
          </p>
        </header>

        {loading ?
          <ul className="divide-foreground/8 border-foreground/8 bg-card/40 divide-y rounded-2xl border">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="animate-pulse space-y-2 px-5 py-4"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="bg-foreground/8 h-4 w-1/3 rounded" />
                <div className="bg-foreground/6 h-3 w-2/3 rounded" />
              </li>
            ))}
          </ul>
        : notes.length === 0 ?
          <div className="border-foreground/10 text-muted-foreground flex flex-col items-start gap-2 rounded-2xl border border-dashed px-6 py-10">
            <p className="font-display text-foreground text-2xl leading-tight italic">
              Nothing yet.
            </p>
            <p className="text-sm">
              Use the form on the right to capture your first thought.
            </p>
          </div>
        : <ul className="divide-foreground/8 border-foreground/10 bg-card/60 divide-y overflow-hidden rounded-2xl border shadow-[0_1px_0_0_var(--color-foreground)]/[0.02]">
            {notes.map((n, i) => (
              <li
                key={n.id}
                className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards hover:bg-foreground/3 group relative px-5 py-4 duration-500"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="text-foreground font-medium">{n.title}</div>
                {n.body && (
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                    {n.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        }
      </section>

      <aside className="md:sticky md:top-24 md:self-start">
        <form
          onSubmit={handleCreate}
          className="border-foreground/10 bg-card/70 hover:border-foreground/15 group flex flex-col gap-4 rounded-2xl border p-5 backdrop-blur-sm transition-colors"
        >
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-[0.7rem] font-medium tracking-[0.18em] uppercase">
              New note
            </p>
            <span className="text-muted-foreground/60 font-display text-xs italic">
              draft
            </span>
          </div>
          <input
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="border-foreground/15 focus:border-foreground w-full border-0 border-b bg-transparent py-2 font-medium transition-colors focus:ring-0 focus:outline-none"
          />
          <textarea
            placeholder="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="border-foreground/15 focus:border-foreground w-full resize-none border-0 border-b bg-transparent py-2 text-sm leading-relaxed transition-colors focus:ring-0 focus:outline-none"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!title.trim()}
            className="self-end"
          >
            Add note
          </Button>
        </form>
      </aside>
    </div>
  );
}
