import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageBadge } from '@/components/ui';

describe('StageBadge', () => {
  it('labels each sales stage, "lost" as Not a fit, and skips unknown values', () => {
    const { container } = render(<><StageBadge stage="quoting" /><StageBadge stage="lost" /><StageBadge stage="bogus" /><StageBadge stage={null} /></>);
    expect(screen.getByText('Quoting')).toBeInTheDocument();
    expect(screen.getByText('Not a fit')).toBeInTheDocument();
    expect(container.querySelectorAll('span.rounded-full')).toHaveLength(2);
  });
});
