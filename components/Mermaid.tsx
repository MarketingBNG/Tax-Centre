'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Renders a ```mermaid fence as a diagram.
 *
 * The library is a few hundred kilobytes and most conversations never contain a
 * diagram, so it is imported on first use rather than in the page bundle. A
 * diagram that fails to parse falls back to showing the source, because a
 * half-written flowchart mid-stream is the normal case, not an error.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        });
        const { svg: rendered } = await mermaid.render(`m${id}`, chart);
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (failed || (!svg && !chart.trim())) {
    return (
      <pre className="my-3 overflow-x-auto rounded-lg border border-line bg-panel p-3">
        <code className="block font-mono text-[13px] leading-[1.5]">{chart}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 rounded-lg border border-line bg-panel p-3 text-[13px] text-ink-faint">
        Drawing diagram…
      </div>
    );
  }

  return (
    <div
      ref={holder}
      className="my-3 overflow-x-auto rounded-lg border border-line bg-panel p-3"
      // The SVG comes from mermaid's own renderer with securityLevel 'strict',
      // which strips scripts and event handlers from the diagram source.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
