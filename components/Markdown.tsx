'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders model output as markdown — tables, lists, code blocks, links.
 *
 * Safety: react-markdown builds React elements rather than injecting HTML, and
 * raw HTML in the source is ignored because `rehype-raw` is deliberately not
 * installed. Its default `urlTransform` also drops `javascript:` and other
 * unsafe schemes. That matters here because this text derives from uploaded
 * client documents, which are attacker-controlled input.
 */

const CITATION_MARKER = /\[\[c\d+\]\]/g;

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Internal citation markers anchor findings to pages; they are not for humans.
  const cleaned = text.replace(CITATION_MARKER, '');

  return (
    <div className="trc-md break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h3 className="mt-5 mb-2 text-[16px] font-semibold" {...p} />,
          h2: (p) => <h3 className="mt-5 mb-2 text-[15px] font-semibold" {...p} />,
          h3: (p) => <h3 className="mt-4 mb-1.5 text-[14.5px] font-semibold" {...p} />,
          h4: (p) => <h4 className="mt-3 mb-1 text-[14px] font-semibold" {...p} />,
          p: (p) => <p className="my-2 leading-[1.6] first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
          li: (p) => <li className="leading-[1.55]" {...p} />,
          strong: (p) => <strong className="font-semibold" {...p} />,
          em: (p) => <em className="italic" {...p} />,
          hr: () => <hr className="my-4 border-line-soft" />,
          blockquote: (p) => (
            <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-dim" {...p} />
          ),
          a: ({ href, ...p }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-accent underline decoration-accent/40 hover:decoration-accent"
              {...p}
            />
          ),
          code: ({ className, children, ...p }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code className="block font-mono text-[12.5px] leading-[1.5]" {...p}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded border border-line-soft bg-raised px-1.5 py-0.5 font-mono text-[12.5px]"
                {...p}
              >
                {children}
              </code>
            );
          },
          pre: (p) => (
            <pre
              className="my-3 overflow-x-auto rounded-lg border border-line bg-panel p-3"
              {...p}
            />
          ),
          // Wide tables scroll inside their own box rather than stretching the thread.
          table: (p) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[13px]" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-raised" {...p} />,
          th: (p) => (
            <th
              className="border-b border-line px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink-dim"
              {...p}
            />
          ),
          td: (p) => <td className="border-b border-line-soft px-2.5 py-1.5 align-top" {...p} />,
        }}
      >
        {cleaned}
      </ReactMarkdown>
      {streaming ? <span className="trc-cursor" /> : null}
    </div>
  );
}
