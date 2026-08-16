/**
 * Markdown renderer for assistant messages.
 * Uses react-markdown + rehype-highlight for syntax-highlighted code blocks.
 */
import { useState } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { useI18n } from './i18n';

// ── Code block with copy button (Wave 3) ────────────────

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* non-fatal */ });
  };
  return (
    <div className="md-code-block">
      <div className="md-code-lang">
        <span>{language}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={copy}
          aria-label={copied ? t('chat.codeCopied') : t('chat.codeCopy')}
          title={copied ? t('chat.codeCopied') : t('chat.codeCopy')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('chat.codeCopied') : t('chat.codeCopy')}
        </button>
      </div>
      <pre className={`hljs language-${language}`}>
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}

// ── Custom components ──────────────────────────────────

const components: Components = {
  // ── Code blocks ──────────────────────────────────
  code({ className, children, node, ...rest }) {
    const match = /language-(\S+)/.exec(className ?? '');
    const text = String(children).replace(/\n$/, '');

    // Code block (has language-* class)
    if (match) {
      return <CodeBlock language={match[1]} code={text} />;
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
