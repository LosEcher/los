/**
 * Virtual scroller wrapper for chat messages.
 * Uses @tanstack/react-virtual for windowed rendering.
 * Auto-scrolls to bottom on new messages during a run.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import type { ReactNode } from 'react';

export function ChatVirtualScroller({
  messages,
  running,
  children,
  debugMode,
}: {
  messages: Array<{ id: string }>;
  running: boolean;
  children: (index: number) => ReactNode;
  debugMode: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const estimateSize = useCallback(() => 120, []);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 8,
  });

  // Auto-scroll to bottom on new messages during streaming, unless user scrolled up
  useEffect(() => {
    if (!running || debugMode) return;
    if (!userScrolledUp) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, running, debugMode, userScrolledUp]);

  // Track user scroll position
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isUp = distFromBottom > 120;
    setUserScrolledUp(isUp);
    setShowScrollBtn(isUp && running);
  }, [running]);

  // When run completes, reset scroll state
  useEffect(() => {
    if (!running) {
      setUserScrolledUp(false);
      setShowScrollBtn(false);
    }
  }, [running]);

  return (
    <div className="virtual-scroller-container">
      <div
        ref={parentRef}
        className="virtual-scroller-viewport"
        onScroll={handleScroll}
        style={{ height: '100%', overflow: 'auto' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map(virtualItem => (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {children(virtualItem.index)}
            </div>
          ))}
        </div>
      </div>
      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          type="button"
          onClick={() => {
            virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            setUserScrolledUp(false);
            setShowScrollBtn(false);
          }}
        >
          <ArrowDown size={14} /> scroll to bottom
        </button>
      )}
    </div>
  );
}
