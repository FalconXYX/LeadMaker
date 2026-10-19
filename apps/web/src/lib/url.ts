// URLs from scraped data, NWS alerts and news feeds are untrusted: only absolute http(s) URLs become links.

/** The URL normalised (scheme added for a bare domain) when it is http(s); null otherwise. */
export function safeExternalUrl(raw: string | null | undefined, opts: { assumeHttps?: boolean } = {}): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const candidate = opts.assumeHttps && !/^[a-z][a-z\d+.-]*:/i.test(s) ? `https://${s.replace(/^\/+/, '')}` : s;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}
