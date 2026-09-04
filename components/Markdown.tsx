'use client';

import { Children, cloneElement, isValidElement, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Mermaid } from './Mermaid';

/**
 * Renders model output as markdown — tables, lists, code blocks, links, maths
 * and mermaid diagrams, plus the citation chips that link an assertion back to
 * the page it came from.
 *
 * Safety: react-markdown builds React elements rather than injecting HTML, and
 * raw HTML in the source is ignored because `rehype-raw` is deliberately not
 * installed. Its default `urlTransform` also drops `javascript:` and other
 * unsafe schemes. That matters here because this text derives from uploaded
 * client documents, which are attacker-controlled input.
 */

export interface Source {
  id: string;
  filename: string;
}

/** `[[cite:FILE_ID|WHERE]]`, the form the system prompt asks for. */
const CITATION = /\[\[cite:([^\]|]+)(?:\|([^\]]*))?\]\]/g;
/** Older marker from the review-era prompt; strip rather than render. */
const LEGACY_MARKER = /\[\[c\d+\]\]/g;

// Private-use characters, so the marker survives markdown parsing untouched.
// Left as literal text it would be parsed as a link reference and torn apart
// across nodes, which is exactly what makes it unrecoverable in the renderer.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const PLACEHOLDER = /\uE000(\d+)\uE001/;

interface Citation {
  fileId: string;
  where: string;
  number: number;
}

/**
 * Escapes dollar signs that introduce a figure, so a pair like `$18,998` …
 * `$39` is not read as a maths span by remark-math and swallowed. Money is the
 * overwhelmingly common use of `$` in a tax thread; genuine LaTeX still works
 * wherever the delimiter is not sitting against a digit, and fenced or inline
 * code is left alone.
 */
function shieldCurrency(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((chunk, i) =>
      i % 2 ? chunk : chunk.replace(/(?<![\\$])\$(?=\s?[\d.,])/g, '\\$'),
    )
    .join('');
}

/**
 * Pulls the citation markers out and leaves numbered placeholders behind.
 * Numbering is derived from the text itself, so it does not shift between
 * renders of the same message.
 */

function extract(text: string): { body: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const numbers = new Map<string, number>();

  const body = text.replace(LEGACY_MARKER, '').replace(CITATION, (_match, id: string, where = '') => {
    const fileId = id.trim();
    const at = (where ?? '').trim();
    const key = `${fileId}|${at}`;

    let number = numbers.get(key);
    if (number === undefined) {
      number = numbers.size + 1;
      numbers.set(key, number);
      citations.push({ fileId, where: at, number });
    }
    return `${OPEN}${number}${CLOSE}`;
  });

  return { body, citations };
}

function Chip({ citation, source }: { citation: Citation; source?: Source }) {
  // A citation naming a document this conversation cannot see is a model
  // mistake; showing a dead chip would be worse than showing nothing.
  if (!source) return null;

  const label = citation.where ? `${source.filename} — ${citation.where}` : source.filename;

  return (
    <a
      href={`/api/files/${citation.fileId}/raw`}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      className="mx-0.5 inline-flex h-[15px] min-w-[15px] translate-y-[-2px] items-center justify-center rounded-[4px] border border-line bg-raised px-1 align-middle font-mono text-[10px] text-ink-dim no-underline hover:border-accent hover:text-accent"
    >
      {citation.number}
    </a>
  );
}

/** Swaps the placeholders back for chips, wherever they ended up in the tree. */
function decorate(node: ReactNode, citations: Citation[], sources: Map<string, Source>): ReactNode {
  if (typeof node === 'string') {
    if (!PLACEHOLDER.test(node)) return node;
    return node.split(/(\uE000\d+\uE001)/).map((piece, i) => {
      const match = piece.match(PLACEHOLDER);
      if (!match) return piece;
      const citation = citations.find((c) => c.number === Number(match[1]));
      if (!citation) return null;
      return (
        <Chip key={i} citation={citation} source={sources.get(citation.fileId)} />
      );
    });
  }

  if (Array.isArray(node)) {
    return Children.map(node, (child) => decorate(child, citations, sources));
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    if (props.children === undefined) return node;
    return cloneElement(
      node as React.ReactElement<{ children?: ReactNode }>,
      undefined,
      decorate(props.children, citations, sources),
    );
  }

  return node;
}

/** Flattens a code block back to a string, for the copy button and for mermaid. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = textOf(children);

  return (
    <div className="group/code relative my-3">
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* the browser blocked the clipboard; nothing useful to say here */
          }
        }}
        className="absolute top-2 right-2 rounded border border-line bg-panel px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-line bg-panel p-3">{children}</pre>
    </div>
  );
}

export function Markdown({
  text,
  streaming = false,
  sources = [],
}: {
  text: string;
  streaming?: boolean;
  sources?: Source[];
}) {
  const { body, citations } = useMemo(() => extract(shieldCurrency(text)), [text]);
  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  const cite = (node: ReactNode) => decorate(node, citations, byId);

  return (
    <div className="trc-md break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, output: 'htmlAndMathml' }]]}
        components={{
          h1: ({ children }) => <h3 className="mt-5 mb-2 text-[16px] font-semibold">{cite(children)}</h3>,
          h2: ({ children }) => <h3 className="mt-5 mb-2 text-[15px] font-semibold">{cite(children)}</h3>,
          h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-[14.5px] font-semibold">{cite(children)}</h3>,
          h4: ({ children }) => <h4 className="mt-3 mb-1 text-[14px] font-semibold">{cite(children)}</h4>,
          p: ({ children }) => <p className="my-2 leading-[1.6] first:mt-0 last:mb-0">{cite(children)}</p>,
          ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
          ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
          li: ({ children }) => <li className="leading-[1.55]">{cite(children)}</li>,
          strong: (p) => <strong className="font-semibold" {...p} />,
          em: (p) => <em className="italic" {...p} />,
          hr: () => <hr className="my-4 border-line-soft" />,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-dim">
              {cite(children)}
            </blockquote>
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
            const language = /language-(\w+)/.exec(className ?? '')?.[1];
            if (language === 'mermaid') return <Mermaid chart={textOf(children)} />;
            if (language) {
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
          // A mermaid fence has already become a diagram by the time it gets
          // here, so it must not also be wrapped in a code frame.
          pre: ({ children }) => {
            const inner = Children.toArray(children)[0];
            if (isValidElement(inner)) {
              const cls = (inner.props as { className?: string }).className ?? '';
              if (cls.includes('language-mermaid')) return <>{children}</>;
            }
            return <CodeBlock>{children}</CodeBlock>;
          },
          // Wide tables scroll inside their own box rather than stretching the thread.
          table: (p) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[13px]" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-raised" {...p} />,
          th: ({ children }) => (
            <th className="border-b border-line px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink-dim">
              {cite(children)}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line-soft px-2.5 py-1.5 align-top">{cite(children)}</td>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
      {streaming ? <span className="trc-cursor" /> : null}
    </div>
  );
}
