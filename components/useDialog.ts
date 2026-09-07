'use client';

import { useEffect, useRef } from 'react';

/**
 * The keyboard half of a modal.
 *
 * Every dialog here already closed on Escape, but that was the only part of the
 * contract any of them kept: Tab walked straight out of the panel and into the
 * page behind it, and closing left focus on `document.body`, so a keyboard user
 * lost their place entirely. The four dialogs did it four slightly different
 * ways, which is why this is a hook rather than a fix repeated in each.
 *
 * Returns a ref to put on the panel — the element that should contain focus,
 * not the backdrop.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const panelRef = useRef<T>(null);
  // Captured on open, restored on close: whatever the user was on before.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;

    // Move focus in, so the first Tab lands inside the dialog rather than at
    // the top of the page behind it.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus({ preventScroll: true });
    }

    return () => returnTo.current?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends rather than letting Tab escape to the page behind.
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return panelRef;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
