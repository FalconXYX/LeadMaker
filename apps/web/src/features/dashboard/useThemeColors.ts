// Leaflet paths take literal colours, so read the theme tokens from CSS and re-read them when the
// colour scheme changes (OS setting or a data-theme attribute on <html>).
import { useEffect, useState } from 'react';

const TOKENS = {
  strategic: '--c-seg-strategic',
  growth: '--c-seg-growth',
  emerging: '--c-seg-emerging',
  long_tail: '--c-seg-long-tail',
  high: '--c-timing-high',
  medium: '--c-timing-medium',
  low: '--c-timing-low',
  info: '--c-timing-info',
  surface: '--c-surface',
  subtle: '--c-subtle',
  owner1: '--dash-owner-1',
  owner2: '--dash-owner-2',
  owner3: '--dash-owner-3',
  owner4: '--dash-owner-4',
  owner5: '--dash-owner-5',
  owner6: '--dash-owner-6',
  owner7: '--dash-owner-7',
  owner8: '--dash-owner-8',
} as const;

export type ThemeColors = Record<keyof typeof TOKENS, string> & { owners: string[] };

function read(): ThemeColors {
  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const [name, cssVar] of Object.entries(TOKENS) as [keyof typeof TOKENS, string][]) {
    // currentColor only where no stylesheet is loaded (tests).
    out[name] = style?.getPropertyValue(cssVar).trim() || 'currentColor';
  }
  return { ...out, owners: [out.owner1, out.owner2, out.owner3, out.owner4, out.owner5, out.owner6, out.owner7, out.owner8] };
}

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const update = () => setColors((prev) => {
      const next = read();
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', update);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    update();
    return () => {
      mq?.removeEventListener?.('change', update);
      mo?.disconnect();
    };
  }, []);
  return colors;
}
