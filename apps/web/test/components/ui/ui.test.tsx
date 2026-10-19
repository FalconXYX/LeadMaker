import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeExternalUrl } from '@/lib/url';
import { readableWeatherText } from '@/lib/labels';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { IconButton } from '@/components/ui/IconButton';
import { Segmented } from '@/components/ui/Segmented';
import { Tooltip } from '@/components/ui/Tooltip';

afterEach(() => vi.useRealTimers());

describe('Tooltip', () => {
  it('shows on hover after a delay, describes its trigger, and closes on Escape', () => {
    vi.useFakeTimers();
    render(<Tooltip content="Priority score 82.5 of 100"><button type="button">82</button></Tooltip>);
    const trigger = screen.getByRole('button', { name: '82' });
    expect(trigger).toHaveAccessibleDescription('Priority score 82.5 of 100');
    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Priority score 82.5 of 100');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus but not on a click', async () => {
    const user = userEvent.setup();
    render(<><button type="button">before</button><Tooltip content="Sort the list"><button type="button">Sort</button></Tooltip></>);
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sort the list');
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('labels icon buttons without repeating the label as a description', () => {
    render(<IconButton label="Close" icon={<span />} />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button).not.toHaveAttribute('title');
    expect(button).not.toHaveAccessibleDescription();
  });
});

describe('Segmented', () => {
  it('moves the choice with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<Segmented label="View" value="map" onChange={onChange} options={[{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }]} />);
    screen.getByRole('radio', { name: 'Map' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('list');
  });
});

describe('external links', () => {
  it('only links http(s) URLs, opening them in a new tab without opener or referrer', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,hi')).toBeNull();
    expect(safeExternalUrl('example.com', { assumeHttps: true })).toBe('https://example.com/');
    expect(safeExternalUrl('https://api.weather.gov/alerts/1')).toBe('https://api.weather.gov/alerts/1');
    render(
      <>
        <ExternalLink href="https://news.example.com/a">Roofers busy</ExternalLink>
        <ExternalLink href="javascript:alert(1)">Bad link</ExternalLink>
      </>,
    );
    const good = screen.getByRole('link', { name: /Roofers busy/ });
    expect(good).toHaveAttribute('target', '_blank');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Bad link/ })).toBeNull();
    expect(screen.getByText('Bad link')).toBeInTheDocument();
  });

  it('renders untrusted markup as text', () => {
    render(<ExternalLink href="https://x.example.com">{'<img src=x onerror=alert(1)>'}</ExternalLink>);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('link')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});

describe('readableWeatherText', () => {
  it('turns storm report codes and ISO dates into words', () => {
    const year = new Date().getUTCFullYear();
    expect(readableWeatherText(`latest ${year}-09-26 NON-TSTM WND DMG at 3 W Ramsey.`)).toBe('latest Sep 26: wind damage at 3 W Ramsey.');
    expect(readableWeatherText('HAIL reported.')).toBe('Hail reported.');
    expect(readableWeatherText('No codes here')).toBe('No codes here');
  });
});
