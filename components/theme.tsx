'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Appearance: light, dark, or whatever the machine is set to.
 *
 * "system" is stored as the *absence* of the attribute rather than a third
 * value, so the CSS media query does the work and nothing has to listen for
 * the OS changing its mind mid-session.
 */
export type Theme = 'light' | 'dark' | 'system';

const KEY = 'trc-theme';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    /* private window, or site data blocked; the choice just will not persist */
  }
}

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* as above */
  }
  return 'system';
}

/**
 * Runs before first paint, inlined in <head>.
 *
 * Without it the page renders in the default palette and then corrects itself
 * once React hydrates — a white flash on every load for anyone who chose dark,
 * which is the majority here. Deliberately tiny and dependency-free, because
 * it blocks paint.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`;

/** The three-way control, as it appears in Settings. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  // Read after mount: the server has no localStorage, and rendering the real
  // value straight away would be a hydration mismatch.
  useEffect(() => setTheme(readTheme()), []);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    applyTheme(next);
  }, []);

  const options: { id: Theme; label: string; icon: string }[] = [
    { id: 'system', label: 'System', icon: '🖥' },
    { id: 'light', label: 'Light', icon: '☀' },
    { id: 'dark', label: 'Dark', icon: '☾' },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="inline-flex items-center gap-1 rounded-[9px] border border-line p-1"
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={theme === o.id}
          onClick={() => choose(o.id)}
          title={o.label}
          className={`flex items-center gap-2 rounded-[6px] px-3 py-1 text-[13px] ${
            theme === o.id ? 'bg-raised text-ink' : 'text-ink-dim hover:text-ink'
          }`}
        >
          <span aria-hidden>{o.icon}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}
