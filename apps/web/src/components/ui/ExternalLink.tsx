import { ExternalLink as ExternalIcon } from 'lucide-react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { safeExternalUrl } from '@/lib/url';

export interface ExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> {
  /** Untrusted (scraped / third-party) URL: only http(s) becomes a link. */
  href: string | null | undefined;
  children: ReactNode;
  /** Trailing "opens elsewhere" icon. */
  icon?: boolean;
  /** Rendered instead when the URL is missing or not http(s); defaults to the children as plain text. */
  fallback?: ReactNode;
}

/** A link that leaves the app: new tab, no opener, no referrer, http(s) only, announced to screen readers. */
export function ExternalLink({ href, children, icon = false, fallback, className, ...rest }: ExternalLinkProps) {
  const url = safeExternalUrl(href);
  if (!url) return <>{fallback === undefined ? <span className={className}>{children}</span> : fallback}</>;
  return (
    <a {...rest} href={url} target="_blank" rel="noopener noreferrer" className={cn(icon && 'group', className)}>
      {children}
      {icon && <ExternalIcon className="ml-1 inline size-3 shrink-0 align-baseline text-subtle group-hover:text-accent" aria-hidden />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
