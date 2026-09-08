/**
 * The shared class strings, deliberately outside `ui.tsx`.
 *
 * `ui.tsx` is a `'use client'` module. A plain function exported from one of
 * those cannot be *called* by a server component — it arrives as a client
 * reference proxy and throws at request time, which a type-check will not
 * catch. The login page and the engagement page are both server components and
 * both need a button, so the strings live here, where either side can call
 * them, and `ui.tsx` re-exports them for everything else.
 *
 * There were thirty-five distinct button class strings for what is really
 * three or four buttons — the same control drifting a half-pixel of padding
 * and a different hover colour each time somebody wrote a new panel. They are
 * exported as strings rather than wrapped in a component because a good half
 * of the call sites are `<Link>` or `<label>`, not `<button>`, and they all
 * need to look identical.
 *
 * `primary` is the only thing in the app that gets the accent as a fill, so
 * the one obvious action on a screen stays obvious.
 */

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-[9px] no-underline transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

// A 4px ladder that still reads as three sizes: rounding sm and md to the
// grid had left both at px-3, which is not two sizes, it is one.
const BTN_SIZE = {
  sm: 'px-2 py-1 text-[13px]',
  md: 'px-3 py-2 text-[13px]',
  lg: 'px-4 py-3 text-[14px]',
} as const;

const BTN_INTENT = {
  // The transparent border is load-bearing: without it primary is 2px shorter
  // than the bordered intents, and every row that mixes them sits crooked.
  primary: 'border border-transparent bg-accent font-medium text-accent-ink hover:bg-accent-hover',
  secondary: 'border border-line bg-raised hover:bg-raised-hover',
  quiet: 'border border-line text-ink-dim hover:border-accent hover:text-accent',
  danger: 'border border-line text-ink-dim hover:border-sev-blocking hover:text-sev-blocking',
} as const;

export function btn(
  intent: keyof typeof BTN_INTENT = 'secondary',
  size: keyof typeof BTN_SIZE = 'md',
  extra = '',
): string {
  return `${BTN_BASE} ${BTN_SIZE[size]} ${BTN_INTENT[intent]}${extra ? ' ' + extra : ''}`;
}

/**
 * Text inputs and textareas had the same problem on a smaller scale. The focus
 * border is the one place `#3c4653` appears; it is deliberately not the accent,
 * so focus reads as "here" rather than as "this is the action".
 */
export const field =
  'w-full rounded-[9px] border border-line bg-canvas px-3 py-2 text-[13px] outline-none ' +
  'placeholder:text-ink-faint focus:border-[#3c4653]';

/**
 * The three page widths, named so they stop drifting.
 *
 * They were never arbitrary — a list of engagements wants the room, a page of
 * prose findings wants a reading measure, and a form wants to be narrow enough
 * that the eye does not travel. But they were fifteen literal values with no
 * label on the intent, so each new page picked whichever number was nearest.
 */
export const page = {
  /** Lists, tables, admin: uses the width it is given. */
  wide: 'mx-auto max-w-[1000px] px-4 py-6 sm:px-6',
  /** Prose the partner reads top to bottom. Narrower on purpose. */
  read: 'mx-auto max-w-[900px] px-4 py-6 sm:px-6',
  /** Forms and the composer. */
  form: 'mx-auto max-w-[780px] px-4 py-6 sm:px-6',
} as const;
