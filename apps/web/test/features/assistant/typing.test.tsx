// The typing indicator says what the assistant is doing, then that it is still working (product review M1: 12-47 s of
// silent dots on the free tier).
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SLOW_MS, TypingIndicator } from '@/features/assistant/Messages';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TypingIndicator', () => {
  it('shows the server\'s progress line, then "Still working on it…" after a while', () => {
    vi.useFakeTimers();
    render(<TypingIndicator label="Searching your leads…" />);
    expect(screen.getByTestId('typing-label')).toHaveTextContent('Searching your leads…');
    act(() => {
      vi.advanceTimersByTime(SLOW_MS + 10);
    });
    expect(screen.getByTestId('typing-label')).toHaveTextContent('Still working on it…');
  });

  it('is just the dots without a label', () => {
    render(<TypingIndicator />);
    expect(screen.queryByTestId('typing-label')).toBeNull();
  });
});
