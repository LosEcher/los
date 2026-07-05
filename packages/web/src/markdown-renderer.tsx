/**
 * Markdown renderer for assistant messages.
 * Uses react-markdown + rehype-highlight for syntax-highlighted code blocks.
 */
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';

// ── Highlight.js theme ─────────────────────────────────

// ── Custom components ──────────────────────────────────

const components: Components = {
  // ── Code blocks ──────────────────────────────────
  code({ className, children, node, ...rest }) {
    const match = /language-(\S+)/.exec(className ?? '');
    const text = String(children).replace(/\n$/, '');

    // Code block (has language-* class)
    if (match) {
      return (
        <div className="md-code-block">
          <div className="md-code-lang">{match[1]}</div>
          <pre className={`hljs language-${match[1]}`}>
            <code className={className} {...rest}>
              {text}
            </code>
          </pre>
        </div>
      );
    }

    // Inline code
    return (
      <code className="md-inline-code" {...rest}>
        {children}
      </code>
    );
  },

  // ── Links open in new tab ────────────────────────
  a({ href, children, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },

  // ── Tables ───────────────────────────────────────
  table({ children }) {
    return <div className="md-table-wrap"><table>{children}</table></div>;
  },
};

// ── MarkdownBlock ──────────────────────────────────────

export function MarkdownBlock({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="markdown-block">
      <Markdown rehypePlugins={[rehypeHighlight]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
