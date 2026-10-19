// Markdown-lite for model output, which is untrusted: everything renders as React text nodes (so HTML is
// shown literally, never parsed), and only a small subset becomes markup: paragraphs, line breaks,
// "-"/"1." lists, "#" headings (as bold lines), **bold**, *italic*, `code`, and [links](/leads/:id).
// Any other link keeps its text and drops the URL. Unclosed markers (mid-stream) stay as plain text.
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

/** The only link targets allowed: a lead profile, optionally with its tab. */
const LEAD_LINK = /^\/leads\/([A-Za-z0-9-]{1,64})\/?(\?tab=(overview|contacts|tags|weather))?$/;

export function isLeadHref(href: string): boolean {
  return LEAD_LINK.test(href);
}

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'h'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[]; start: number };

const UL_ITEM = /^\s*[-*•+]\s+(.*)$/;
const OL_ITEM = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const ul = UL_ITEM.exec(line);
    const ol = ul ? null : OL_ITEM.exec(line);
    const h = ul || ol ? null : HEADING.exec(line);
    if (ul) {
      if (current?.type !== 'ul') {
        flush();
        current = { type: 'ul', items: [] };
      }
      current.items.push(ul[1]!);
    } else if (ol) {
      if (current?.type !== 'ol') {
        flush();
        current = { type: 'ol', items: [], start: Number(ol[1]) || 1 };
      }
      current.items.push(ol[2]!);
    } else if (h) {
      flush();
      blocks.push({ type: 'h', text: h[1]! });
    } else if ((current?.type === 'ul' || current?.type === 'ol') && /^\s+\S/.test(line)) {
      // An indented line continues the previous list item.
      current.items[current.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (current?.type !== 'p') {
        flush();
        current = { type: 'p', lines: [] };
      }
      current.lines.push(line.trim());
    }
  }
  flush();
  return blocks;
}

// Order matters: links first (their text may hold bold), then code, bold, italic.
const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g;

export interface InlineOptions {
  onLeadLink?: () => void;
}

export function renderInline(text: string, opts: InlineOptions = {}, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(INLINE.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${depth}-${m.index}`;
    const [, linkText, href, code, bold1, bold2, italic] = m;
    if (linkText !== undefined && href !== undefined) {
      const inner = depth < 2 ? renderInline(linkText, opts, depth + 1) : [linkText];
      out.push(isLeadHref(href)
        ? (
          <Link key={key} to={href} onClick={opts.onLeadLink} className="font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
            {inner}
          </Link>
        )
        : <Fragment key={key}>{inner}</Fragment>);
    } else if (code !== undefined) {
      out.push(<code key={key} className="rounded bg-surface-3 px-1 py-px font-mono text-[0.92em]">{code}</code>);
    } else if (bold1 !== undefined || bold2 !== undefined) {
      const inner = bold1 ?? bold2!;
      out.push(<strong key={key} className="font-semibold text-fg">{depth < 2 ? renderInline(inner, opts, depth + 1) : inner}</strong>);
    } else if (italic !== undefined) {
      out.push(<em key={key}>{depth < 2 ? renderInline(italic, opts, depth + 1) : italic}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface MarkdownProps extends InlineOptions {
  text: string;
  /** Rendered at the end of the last block (the streaming caret). */
  trailing?: ReactNode;
}

export function Markdown({ text, trailing, onLeadLink }: MarkdownProps) {
  const blocks = parseBlocks(text);
  const opts = { onLeadLink };
  if (blocks.length === 0) return trailing ? <p>{trailing}</p> : null;
  return (
    <div className="space-y-2 break-words">
      {blocks.map((b, i) => {
        const tail = i === blocks.length - 1 ? trailing : null;
        switch (b.type) {
          case 'h':
            return <p key={i} className="font-semibold text-fg">{renderInline(b.text, opts)}{tail}</p>;
          case 'p':
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>{j > 0 && <br />}{renderInline(l, opts)}</Fragment>
                ))}
                {tail}
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc space-y-1 pl-5 marker:text-subtle">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, opts)}{j === b.items.length - 1 && tail}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5 marker:text-subtle">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, opts)}{j === b.items.length - 1 && tail}</li>)}
              </ol>
            );
        }
      })}
    </div>
  );
}
